import { describe, it, expect, vi, beforeEach } from "vitest";
import { processEmailsForAccount } from "./process-account";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { validateWebhookAccount } from "@/utils/webhook/validate-webhook-account";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { getEmailProviderRateLimitState } from "@/utils/email/rate-limit";
import { processHistoryItem } from "@/utils/webhook/process-history-item";
import { withMessageProcessingLock } from "@/utils/redis/message-processing";

const logger = createScopedLogger("test");

const state = vi.hoisted(() => ({
  redis: new Map<string, string>(),
  pointer: null as string | null,
}));

vi.mock("server-only", () => ({}));

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

vi.mock("@/utils/webhook/validate-webhook-account", () => ({
  validateWebhookAccount: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue({ name: "google" }),
}));
vi.mock("@/utils/gmail/client", () => ({
  getGmailClientWithRefresh: vi.fn(),
}));
vi.mock("@/utils/gmail/profile", () => ({
  getCurrentHistoryId: vi.fn().mockResolvedValue("9999"),
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
      users: { messages: { list: listMessages } },
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
});
