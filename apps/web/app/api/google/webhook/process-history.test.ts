import { describe, it, expect, vi, beforeEach } from "vitest";
import { processHistoryForUser } from "./process-history";
import { getHistory } from "@/utils/gmail/history";
import {
  getWebhookEmailAccount,
  validateWebhookAccount,
} from "@/utils/webhook/validate-webhook-account";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  getEmailProviderRateLimitState,
  withRateLimitRecording,
} from "@/utils/email/rate-limit";
import { createEmailProvider } from "@/utils/email/provider";
import { runRules } from "@/utils/ai/choose-rule/run-rules";
import { fanOutEmailAnalysis } from "@/utils/email-fanout";
import { SafeError } from "@/utils/error";
import { GmailLabel } from "@/utils/gmail/label";

const logger = createScopedLogger("test");
// Mock logger.with to return the same logger instance so spies work
vi.spyOn(logger, "with").mockReturnValue(logger);

// In-memory stand-ins for the state the pointer rule depends on: the Redis
// keys (message locks, catch-up marker), ExecutedRule rows and the pointer.
const state = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  executedRuleMessageIds: new Set<string>(),
  pointer: null as string | null,
  rateLimitErrors: [] as unknown[],
  fanOut: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => state.redis.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx && state.redis.has(key)) return null;
      state.redis.set(key, String(value));
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (state.redis.delete(key)) removed++;
      return removed;
    }),
  },
}));

vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/utils/gmail/history", () => ({
  getHistory: vi.fn(),
}));

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  getWebhookEmailAccount: vi.fn(),
  validateWebhookAccount: vi.fn(),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      update: vi.fn().mockResolvedValue({}),
    },
    executedRule: {
      findFirst: vi.fn(async ({ where }: { where: { messageId: string } }) =>
        state.executedRuleMessageIds.has(where.messageId)
          ? { id: `er-${where.messageId}` }
          : null,
      ),
    },
    newsletter: {
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
    },
    // Mirrors the monotonic UPDATE in updateLastSyncedHistoryId.
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray, id: string) => {
      if (state.pointer === null || BigInt(id) > BigInt(state.pointer)) {
        state.pointer = id;
      }
      return 1;
    }),
  },
}));

vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

vi.mock("@/utils/email/rate-limit", () => ({
  getEmailProviderRateLimitState: vi.fn().mockResolvedValue(null),
  withRateLimitRecording: vi.fn(),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));

// Real runRules writes the ExecutedRule (APPLIED or SKIPPED) before it fans
// out, so the stand-in keeps that order.
vi.mock("@/utils/ai/choose-rule/run-rules", () => ({
  runRules: vi.fn(async ({ message }: { message: { id: string } }) => {
    state.executedRuleMessageIds.add(message.id);
    state.fanOut({ message });
    return [];
  }),
}));

vi.mock("@/utils/email-fanout", () => ({
  fanOutEmailAnalysis: state.fanOut,
}));

vi.mock("@/utils/follow-up/labels", () => ({
  clearFollowUpLabel: vi.fn(),
}));

vi.mock("@/utils/log-error-with-dedupe", () => ({
  logErrorWithDedupe: vi.fn(),
}));

describe("processHistoryForUser - 404 Handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("should reset lastSyncedHistoryId when Gmail returns 404 (expired historyId)", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    // Simulate Gmail 404 error
    const error404 = new Error("Requested entity was not found");
    (error404 as any).status = 404;
    vi.mocked(getHistory).mockRejectedValue(error404);

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });

    // Verify lastSyncedHistoryId was updated to the current historyId via conditional update
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it("should skip webhook history calls while account is in rate-limit mode", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue({
      provider: "google",
      retryAt: new Date(Date.now() + 60_000),
      source: "test",
    });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).not.toHaveBeenCalled();
  });

  it("should continue processing when rate-limit state lookup fails", async () => {
    const email = "user@test.com";
    const historyId = 2000;
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);
    vi.mocked(getEmailProviderRateLimitState).mockRejectedValueOnce(
      new Error("redis unavailable"),
    );
    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    const result = await processHistoryForUser(
      { emailAddress: email, historyId },
      {},
      logger,
    );

    const jsonResponse = await (result as any).json();
    expect(jsonResponse).toEqual({ ok: true });
    expect(getHistory).toHaveBeenCalled();
  });

  it("should log a warning and advance cursor when large-gap history is truncated", async () => {
    const email = "user@test.com";
    const historyId = 2000; // Gap of 1000 (2000 - 1000)
    const emailAccount = {
      id: "account-123",
      email,
      lastSyncedHistoryId: "1000",
    };

    vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: {
        emailAccount: {
          ...emailAccount,
          account: {
            access_token: "token",
            refresh_token: "refresh",
            expires_at: new Date(Date.now() + 3_600_000),
          },
          rules: [],
        },
        hasAutomationRules: false,
        hasAiAccess: false,
      },
    } as any);

    vi.mocked(getHistory).mockResolvedValue({ history: [] });

    const warnSpy = vi.spyOn(logger, "warn");

    await processHistoryForUser({ emailAddress: email, historyId }, {}, logger);

    expect(warnSpy).toHaveBeenCalledWith(
      "Skipping history items due to large gap",
      expect.objectContaining({
        lastSyncedHistoryId: 1000,
        webhookHistoryId: 2000,
        skippedHistoryItems: 500, // (2000 - 500) - 1000 = 500
      }),
    );

    // Even if Gmail returns an empty array, advance the cursor to avoid
    // repeatedly reprocessing the same large gap window.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});

// Production shape (2026-11-05): HTTP 429, reason rateLimitExceeded.
function gmailRateLimitError() {
  const message = "Too many concurrent requests for user.";
  return Object.assign(new Error(message), {
    status: 429,
    code: 429,
    errors: [{ reason: "rateLimitExceeded", message }],
    response: {
      status: 429,
      data: {
        error: {
          code: 429,
          message,
          errors: [{ reason: "rateLimitExceeded", message }],
        },
      },
    },
  });
}

// Also seen in production: 403 "Queries quota" with the same reason.
function gmailQueriesQuotaError() {
  const message =
    "Quota exceeded for quota metric 'Queries' and limit 'Queries per minute per user'";
  return Object.assign(new Error(message), {
    status: 403,
    code: 403,
    errors: [{ reason: "rateLimitExceeded", message }],
  });
}

const EMAIL = "user@test.com";
const ACCOUNT_ID = "account-123";

function resetState() {
  state.redis.clear();
  state.executedRuleMessageIds.clear();
  state.pointer = "1000";
  state.rateLimitErrors = [];
  vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
  vi.mocked(withRateLimitRecording).mockImplementation(
    async (context, operation) => {
      try {
        return await operation();
      } catch (error) {
        state.rateLimitErrors.push(error);
        await context.onRateLimitRecorded?.(null, error);
        throw error;
      }
    },
  );
}

function mockAccount() {
  const emailAccount = {
    id: ACCOUNT_ID,
    userId: "user-1",
    email: EMAIL,
    lastSyncedHistoryId: state.pointer,
    autoCategorizeSenders: false,
    autoLearnPatterns: false,
    filingEnabled: false,
    filingPrompt: null,
  };
  vi.mocked(getWebhookEmailAccount).mockResolvedValue(emailAccount as any);
  vi.mocked(validateWebhookAccount).mockResolvedValue({
    success: true,
    data: {
      emailAccount: {
        ...emailAccount,
        account: {
          provider: "google",
          access_token: "token",
          refresh_token: "refresh",
          expires_at: new Date(Date.now() + 3_600_000),
        },
        rules: [],
      },
      hasAutomationRules: true,
      hasAiAccess: true,
    },
  } as any);
}

// Gmail returns history records after startHistoryId.
function mockGmailHistory(entries: { id: string; messageIds: string[] }[]) {
  vi.mocked(getHistory).mockImplementation(async (_gmail, options) => ({
    history: entries
      .filter((e) => BigInt(e.id) > BigInt(options.startHistoryId))
      .map((e) => ({
        id: e.id,
        messagesAdded: e.messageIds.map((id) => ({
          message: {
            id,
            threadId: `thread-${id}`,
            labelIds: [GmailLabel.INBOX],
          },
        })),
      })),
  }));
}

function mockProvider(
  getMessageFailures: Record<string, unknown[]> = {},
  ageMs: Record<string, number> = {},
) {
  const getMessage = vi.fn(async (id: string) => {
    const failure = getMessageFailures[id]?.shift();
    // A function stands for a call still in flight: it settles when the test says.
    if (typeof failure === "function") await failure();
    else if (failure) throw failure;
    return {
      id,
      threadId: `thread-${id}`,
      labelIds: [GmailLabel.INBOX],
      internalDate: String(Date.now() - (ageMs[id] ?? 60_000)),
      snippet: "",
      historyId: "1",
      headers: {
        from: "sender@example.com",
        to: EMAIL,
        subject: "Hi",
        date: new Date().toISOString(),
      },
      textPlain: "Hello",
      textHtml: "<p>Hello</p>",
    };
  });
  vi.mocked(createEmailProvider).mockResolvedValue({
    name: "google",
    getMessage,
    isSentMessage: vi.fn().mockReturnValue(false),
    blockUnsubscribedEmail: vi.fn(),
  } as any);
  return getMessage;
}

async function runWebhook(historyId: number) {
  mockAccount();
  return processHistoryForUser({ emailAddress: EMAIL, historyId }, {}, logger);
}

function rulesRunFor(messageId: string) {
  return vi
    .mocked(runRules)
    .mock.calls.filter(([args]) => args.message.id === messageId).length;
}

function fanOutsFor(messageId: string) {
  return vi
    .mocked(fanOutEmailAnalysis)
    .mock.calls.filter(([args]) => args.message.id === messageId).length;
}

describe("processHistoryForUser - pointer never passes unprocessed mail", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetState();
  });

  it("keeps the pointer before a rate-limited item and surfaces the error to rate-limit recording", async () => {
    const rateLimit = gmailRateLimitError();
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
      { id: "1003", messageIds: ["m3"] },
    ]);
    mockProvider({ m2: [rateLimit] });

    await runWebhook(1003);

    expect(state.pointer).toBe("1001");
    expect(state.rateLimitErrors).toEqual([rateLimit]);
    expect(rulesRunFor("m1")).toBe(1);
    expect(rulesRunFor("m3")).toBe(0);
  });

  it("treats the 403 Queries quota error as a rate limit too", async () => {
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
    ]);
    mockProvider({ m2: [gmailQueriesQuotaError()] });

    await runWebhook(1002);

    expect(state.pointer).toBe("1001");
    expect(state.rateLimitErrors).toHaveLength(1);
  });

  it("a later webhook processes the rate-limited item once, does not re-run item 1, and fans out once per email", async () => {
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
      { id: "1003", messageIds: ["m3"] },
    ]);
    // Pub/Sub does not redeliver (route.ts acks first), so the retry is the
    // next webhook for the account, well inside the 5-minute lock TTL.
    mockProvider({ m2: [gmailRateLimitError()] });

    await runWebhook(1003);
    await runWebhook(1004);

    expect(state.pointer).toBe("1003");
    expect(rulesRunFor("m1")).toBe(1);
    expect(rulesRunFor("m2")).toBe(1);
    expect(rulesRunFor("m3")).toBe(1);
    expect(fanOutsFor("m1")).toBe(1);
    expect(fanOutsFor("m2")).toBe(1);
    expect(fanOutsFor("m3")).toBe(1);
  });

  it("does not run rules twice for items in the same history entry when the entry is retried", async () => {
    mockGmailHistory([{ id: "1001", messageIds: ["m1", "m2", "m3"] }]);
    mockProvider({ m2: [gmailRateLimitError()] });

    await runWebhook(1001);
    expect(state.pointer).toBe("1000");

    await runWebhook(1001);

    expect(state.pointer).toBe("1001");
    expect(rulesRunFor("m1")).toBe(1);
    expect(rulesRunFor("m2")).toBe(1);
    expect(rulesRunFor("m3")).toBe(1);
    expect(fanOutsFor("m1")).toBe(1);
    expect(fanOutsFor("m2")).toBe(1);
  });

  it("releases the message lock on failure so a retry inside 5 minutes is not 'already being processed'", async () => {
    mockGmailHistory([{ id: "1001", messageIds: ["m1"] }]);
    mockProvider({ m1: [gmailRateLimitError()] });

    await runWebhook(1001);
    expect(
      [...state.redis.keys()].some((k) => k.startsWith("processing-message:")),
    ).toBe(false);

    await runWebhook(1001);
    expect(rulesRunFor("m1")).toBe(1);
  });

  it("over 24 hours old: no rule run, no fan-out, pointer advances", async () => {
    mockGmailHistory([{ id: "1001", messageIds: ["old"] }]);
    mockProvider({}, { old: 25 * 60 * 60 * 1000 });
    const infoSpy = vi.spyOn(logger, "info");

    await runWebhook(1001);

    expect(rulesRunFor("old")).toBe(0);
    expect(fanOutsFor("old")).toBe(0);
    expect(infoSpy).toHaveBeenCalledWith("Skipping. Message too old.");
    expect(state.pointer).toBe("1001");
  });

  it("stops and keeps the pointer when the account loses credentials mid-batch", async () => {
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
      { id: "1003", messageIds: ["m3"] },
    ]);
    const getMessage = mockProvider({
      m2: [new SafeError("No refresh token")],
    });

    await runWebhook(1003);

    expect(state.pointer).toBe("1001");
    expect(getMessage).not.toHaveBeenCalledWith("m3");
    expect(state.rateLimitErrors).toEqual([]);
  });

  it("widens the window to 30,000 only while catching up after a rate limit", async () => {
    mockGmailHistory([]);
    mockProvider();

    await runWebhook(40_000);
    expect(vi.mocked(getHistory).mock.calls[0][1].startHistoryId).toBe("39500");

    // A webhook skipped during an active Gmail rate limit marks catch-up.
    state.pointer = "1000";
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValueOnce({
      provider: "google",
      retryAt: new Date(Date.now() + 60_000),
      source: "test",
    });
    await runWebhook(40_000);

    await runWebhook(40_000);
    expect(vi.mocked(getHistory).mock.calls[1][1].startHistoryId).toBe("10000");

    // The completed catch-up clears the mark.
    state.pointer = "1000";
    await runWebhook(40_000);
    expect(vi.mocked(getHistory).mock.calls[2][1].startHistoryId).toBe("39500");
  });

  it("marks catch-up when an item hits the rate limit", async () => {
    mockGmailHistory([{ id: "1001", messageIds: ["m1"] }]);
    mockProvider({ m1: [gmailRateLimitError()] });

    await runWebhook(1001);
    state.pointer = "1000";
    await runWebhook(40_000);

    expect(vi.mocked(getHistory).mock.calls[1][1].startHistoryId).toBe("10000");
  });

  // Documented, unchanged: a non-rate-limit failure (e.g. an LLM error) is
  // logged and the pointer moves past it. That rule run is lost (L-14).
  it("logs a non-rate-limit item error and still advances the pointer", async () => {
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
    ]);
    mockProvider({ m1: [new Error("model unavailable")] });
    const errorSpy = vi.spyOn(logger, "error");

    await runWebhook(1002);

    expect(errorSpy).toHaveBeenCalledWith(
      "Error processing history item",
      expect.anything(),
    );
    expect(state.pointer).toBe("1002");
    expect(rulesRunFor("m2")).toBe(1);
    expect(state.rateLimitErrors).toEqual([]);
  });

  it("does not pass a message another webhook is still processing, and processes it once after that run fails", async () => {
    mockGmailHistory([
      { id: "1001", messageIds: ["m1"] },
      { id: "1002", messageIds: ["m2"] },
      { id: "1003", messageIds: ["m3"] },
      { id: "1004", messageIds: ["m4"] },
    ]);
    let reachedM2!: () => void;
    const aReachedM2 = new Promise<void>((resolve) => {
      reachedM2 = resolve;
    });
    let failM2!: (error: unknown) => void;
    mockProvider({
      m2: [
        () => {
          reachedM2();
          return new Promise((_resolve, reject) => {
            failM2 = reject;
          });
        },
      ],
    });

    const webhookA = runWebhook(1003);
    await aReachedM2;

    // B arrives while A holds m2's lock with getMessage in flight.
    await runWebhook(1004);
    expect(Number(state.pointer)).toBeLessThanOrEqual(1001);
    expect(rulesRunFor("m3")).toBe(0);

    failM2(gmailRateLimitError());
    await webhookA;
    expect(state.pointer).toBe("1001");

    await runWebhook(1004);

    expect(state.pointer).toBe("1004");
    expect(rulesRunFor("m2")).toBe(1);
    expect(fanOutsFor("m2")).toBe(1);
    for (const id of ["m1", "m3", "m4"]) {
      expect(rulesRunFor(id)).toBe(1);
      expect(fanOutsFor(id)).toBe(1);
    }
  });

  it("holds the pointer behind a stale in-flight lock from a killed run, then processes the message after the TTL", async () => {
    mockGmailHistory([{ id: "1001", messageIds: ["m1"] }]);
    mockProvider();
    state.redis.set(`processing-message:${EMAIL}:m1`, "true");

    await runWebhook(1001);
    expect(state.pointer).toBe("1000");
    expect(rulesRunFor("m1")).toBe(0);

    // The 5-minute TTL expires.
    state.redis.delete(`processing-message:${EMAIL}:m1`);
    await runWebhook(1001);

    expect(state.pointer).toBe("1001");
    expect(rulesRunFor("m1")).toBe(1);
    expect(fanOutsFor("m1")).toBe(1);
  });
});
