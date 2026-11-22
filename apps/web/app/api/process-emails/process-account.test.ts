import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEmailsForAccount } from "./process-account";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { validateWebhookAccount } from "@/utils/webhook/validate-webhook-account";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { withMessageProcessingLock } from "@/utils/redis/message-processing";
import { captureException } from "@/utils/error";
import {
  forgetLlmRetry,
  getLlmRetryEntries,
  getLlmRetryMaxAgeMs,
  rememberLlmRetry,
} from "@/utils/redis/llm-retry";

const logger = createScopedLogger("test");

const state = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  pointer: null as string | null,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => state.redis.get(key) ?? null),
    set: vi.fn(async (key: string, value: string, opts?: { nx?: boolean }) => {
      if (opts?.nx && state.redis.has(key)) return null;
      state.redis.set(key, String(value));
      return "OK";
    }),
    // owned-lock scripts: set or delete only when the caller still owns the key
    eval: vi.fn(async (script: string, [key]: string[], [token, value]) => {
      if (state.redis.get(key) !== token) return 0;
      if (script.includes('"DEL"')) state.redis.delete(key);
      else state.redis.set(key, value);
      return 1;
    }),
    del: vi.fn(async (...keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (state.redis.delete(key)) removed++;
      return removed;
    }),
  },
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findUnique: vi.fn(),
      update: vi.fn(async ({ data }) => {
        state.pointer = data.lastSyncedHistoryId;
        return {};
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        if ("lastSyncedHistoryId" in where && state.pointer !== null) {
          return { count: 0 };
        }
        state.pointer = data.lastSyncedHistoryId;
        return { count: 1 };
      }),
    },
    executedRule: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/utils/redis/llm-retry", () => ({
  rememberLlmRetry: vi.fn().mockResolvedValue(undefined),
  getLlmRetryEntries: vi.fn().mockResolvedValue([]),
  forgetLlmRetry: vi.fn().mockResolvedValue(undefined),
  getLlmRetryMaxAgeMs: vi.fn(() => 72 * 60 * 60 * 1000),
}));
vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  validateWebhookAccount: vi.fn(),
  webhookEmailAccountSelect: {},
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue({ name: "google" }),
}));
vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn(),
}));
vi.mock("@/utils/email/rate-limit", () => ({
  getEmailProviderRateLimitState: vi.fn(),
}));
vi.mock("@/utils/webhook/process-history-item", () => ({
  processHistoryItem: vi.fn(),
}));
vi.mock("./process-sent", () => ({
  processRecentSentMessages: vi.fn().mockResolvedValue(0),
}));

const ACCOUNT_ID = "account-1";
const EMAIL = "user@test.com";

describe("processEmailsForAccount - Gmail pointer", () => {
  let listMessages: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    state.redis.clear();
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue(null);
    listMessages = vi.fn().mockResolvedValue({
      data: { messages: [{ id: "m1", threadId: "t1" }] },
    });
    vi.mocked(getGmailClientWithRefresh).mockResolvedValue({
      users: {
        messages: { list: listMessages },
        getProfile: vi.fn().mockResolvedValue({ data: { historyId: "9999" } }),
      },
    } as any);
  });

  function mockAccount(lastSyncedHistoryId: string | null) {
    state.pointer = lastSyncedHistoryId;
    const emailAccount = {
      id: ACCOUNT_ID,
      email: EMAIL,
      userId: "user-1",
      lastSyncedHistoryId,
      account: {
        provider: "google",
        access_token: "token",
        refresh_token: "refresh",
        expires_at: null,
      },
      rules: [],
    };
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(
      emailAccount as any,
    );
    vi.mocked(validateWebhookAccount).mockResolvedValue({
      success: true,
      data: { emailAccount, hasAutomationRules: true, hasAiAccess: true },
    } as any);
  }

  it("leaves an existing pointer unchanged, so it never passes mail the webhook has not processed", async () => {
    mockAccount("1001");

    await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });
    expect(state.pointer).toBe("1001");

    listMessages.mockResolvedValue({ data: { messages: [] } });
    await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });
    expect(state.pointer).toBe("1001");
  });

  it("heals a null pointer with Gmail's current history ID", async () => {
    mockAccount(null);

    await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

    expect(state.pointer).toBe("9999");
  });

  it("skips Gmail entirely during an active rate limit", async () => {
    mockAccount(null);
    vi.mocked(getEmailProviderRateLimitState).mockResolvedValue({
      provider: "google",
      retryAt: new Date(Date.now() + 60_000),
      source: "google/webhook",
    });

    await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

    expect(getGmailClientWithRefresh).not.toHaveBeenCalled();
    expect(processHistoryItem).not.toHaveBeenCalled();
    expect(state.pointer).toBeNull();
  });

  it("runs a message only once when the webhook is processing it at the same time", async () => {
    mockAccount("1001");
    let releaseWebhook!: () => void;
    const webhookRun = withMessageProcessingLock(
      { userEmail: EMAIL, messageId: "m1" },
      () =>
        new Promise<void>((resolve) => {
          releaseWebhook = resolve;
        }),
    );

    await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });
    releaseWebhook();
    await webhookRun;

    expect(processHistoryItem).not.toHaveBeenCalled();
  });

  it("treats a revoked Gmail grant as expected, not as an error to report", async () => {
    mockAccount("1001");
    vi.mocked(getGmailClientWithRefresh).mockRejectedValue(
      Object.assign(
        new Error("invalid_grant: Token has been expired or revoked."),
        {
          response: { data: { error: "invalid_grant" } },
        },
      ),
    );

    const result = await processEmailsForAccount({
      emailAccountId: ACCOUNT_ID,
      logger,
    });

    expect(result).toEqual({ success: false });
    expect(captureException).not.toHaveBeenCalled();
  });

  describe("mail that failed while the model was offline", () => {
    const HOUR = 60 * 60 * 1000;
    const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });

    beforeEach(() => {
      mockAccount("1001");
      listMessages.mockResolvedValue({ data: { messages: [] } });
    });

    function remember(entries: { messageId: string; ageHours: number }[]) {
      vi.mocked(getLlmRetryEntries).mockResolvedValue(
        entries.map(({ messageId, ageHours }) => ({
          messageId,
          firstFailedAt: Date.now() - ageHours * HOUR,
        })),
      );
    }

    it("remembers an unread message the model could not process", async () => {
      listMessages.mockResolvedValue({
        data: { messages: [{ id: "m1", threadId: "t1" }] },
      });
      vi.mocked(processHistoryItem).mockRejectedValueOnce(connectionError);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(rememberLlmRetry).toHaveBeenCalledWith(
        expect.objectContaining({
          emailAccountId: ACCOUNT_ID,
          messageId: "m1",
        }),
      );
    });

    it("does not remember an unread message that failed for another reason", async () => {
      listMessages.mockResolvedValue({
        data: { messages: [{ id: "m1", threadId: "t1" }] },
      });
      vi.mocked(processHistoryItem).mockRejectedValueOnce(
        new Error("Something else broke"),
      );

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(rememberLlmRetry).not.toHaveBeenCalled();
    });

    it("processes a remembered message that was read since, and forgets it", async () => {
      remember([{ messageId: "read-1", ageHours: 2 }]);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "read-1" }),
        expect.anything(),
      );
      expect(forgetLlmRetry).toHaveBeenCalledWith(
        expect.objectContaining({ messageIds: ["read-1"] }),
      );
    });

    it("keeps a remembered message when the model is still offline", async () => {
      remember([{ messageId: "read-1", ageHours: 2 }]);
      vi.mocked(processHistoryItem).mockRejectedValueOnce(connectionError);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledTimes(1);
      expect(forgetLlmRetry).not.toHaveBeenCalledWith(
        expect.objectContaining({ messageIds: ["read-1"] }),
      );
    });

    it("retries a 30 hour old message, past the webhook's 24 hour age guard", async () => {
      remember([{ messageId: "weekend-1", ageHours: 30 }]);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "weekend-1" }),
        expect.objectContaining({ isModelRetry: true }),
      );
    });

    it("does not bypass the age guard for unread mail", async () => {
      listMessages.mockResolvedValue({
        data: { messages: [{ id: "m1", threadId: "t1" }] },
      });

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "m1" }),
        expect.not.objectContaining({ isModelRetry: true }),
      );
    });

    it("counts a retry as succeeded only when an ExecutedRule now exists", async () => {
      const log = {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        trace: vi.fn(),
        with: () => log,
      } as any;
      remember([
        { messageId: "ok-1", ageHours: 2 },
        { messageId: "silent-1", ageHours: 2 },
      ]);
      // 1st call is the pre-retry lookup, 2nd the unread lookup (skipped when
      // nothing is unread), then the post-retry lookup.
      vi.mocked(prisma.executedRule.findMany)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ messageId: "ok-1" }] as any);

      const result = await processEmailsForAccount({
        emailAccountId: ACCOUNT_ID,
        logger: log,
      });

      expect(log.info).toHaveBeenCalledWith(
        "Retried mail that failed while the model was offline",
        expect.objectContaining({ retried: 2, succeeded: 1, dropped: 1 }),
      );
      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining("no ExecutedRule"),
        expect.objectContaining({ messageIds: ["silent-1"] }),
      );
      expect(result.processed).toBe(1);
      expect(forgetLlmRetry).toHaveBeenCalledWith(
        expect.objectContaining({ messageIds: ["ok-1", "silent-1"] }),
      );
    });

    it("drops entries older than 72 hours without processing them", async () => {
      remember([{ messageId: "old-1", ageHours: 73 }]);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).not.toHaveBeenCalled();
      expect(forgetLlmRetry).toHaveBeenCalledWith(
        expect.objectContaining({ messageIds: ["old-1"] }),
      );
    });

    it("keeps retrying entries inside a longer configured window", async () => {
      vi.mocked(getLlmRetryMaxAgeMs).mockReturnValueOnce(120 * HOUR);
      remember([{ messageId: "long-1", ageHours: 100 }]);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: "long-1" }),
        expect.objectContaining({ isModelRetry: true }),
      );
    });

    it("removes an entry that already has an ExecutedRule, unprocessed", async () => {
      remember([{ messageId: "done-1", ageHours: 2 }]);
      vi.mocked(prisma.executedRule.findMany).mockResolvedValueOnce([
        { messageId: "done-1" },
      ] as any);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).not.toHaveBeenCalled();
      expect(forgetLlmRetry).toHaveBeenCalledWith(
        expect.objectContaining({ messageIds: ["done-1"] }),
      );
    });

    it("does not process a remembered message twice when it is also unread", async () => {
      listMessages.mockResolvedValue({
        data: { messages: [{ id: "m1", threadId: "t1" }] },
      });
      remember([{ messageId: "m1", ageHours: 2 }]);

      await processEmailsForAccount({ emailAccountId: ACCOUNT_ID, logger });

      expect(processHistoryItem).toHaveBeenCalledTimes(1);
    });
  });
});
