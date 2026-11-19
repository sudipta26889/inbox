import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { env } from "@/env";
import { createEmailProvider } from "@/utils/email/provider";
import {
  requireSendApproval,
  type SendApproval,
} from "@/utils/mail/send-approval";
import { sendNotificationEmail } from "./send-notification-email";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));

const { memo, mockRunApprovalLoop } = vi.hoisted(() => ({
  memo: new Map<string, string>(),
  mockRunApprovalLoop: vi.fn(),
}));

vi.mock("@/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/env")>();
  return {
    env: {
      ...original.env,
      RESEND_API_KEY: undefined,
      DHARAHIL_BASE_URL: "https://gateway.test",
      DHARAHIL_API_KEY: "key",
    },
  };
});
vi.mock("@/utils/redis", () => ({
  redis: {
    get: async (key: string) => memo.get(key) ?? null,
    set: async (key: string, value: string) => {
      memo.set(key, value);
      return "OK";
    },
  },
}));
vi.mock("@/utils/dharahil/client", () => ({
  dharahilClient: {
    runApprovalLoop: mockRunApprovalLoop,
    shouldProceed: (decision: { action: string }) =>
      ["ALLOW", "APPROVED", "AUTO_ALLOWED"].includes(decision.action),
  },
}));

describe("sendNotificationEmail with an operation id", () => {
  // Stands in for the Gmail provider: its send runs the real gate with the
  // approval it was handed, as the production provider does.
  const sendEmailWithHtml = vi.fn(
    async (
      body: { to: string; subject: string; messageHtml: string },
      options?: { approval?: SendApproval },
    ) => {
      await requireSendApproval({
        operation: "send_email",
        emailAccountId: "account-1",
        to: body.to,
        subject: body.subject,
        bodyHtml: body.messageHtml,
        approval: options?.approval,
      });
    },
  );

  beforeEach(() => {
    vi.clearAllMocks();
    memo.clear();
    expect(env.RESEND_API_KEY).toBeUndefined();
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    vi.mocked(createEmailProvider).mockResolvedValue({
      sendEmailWithHtml,
    } as never);
  });

  it("raises one approval card for one digest send", async () => {
    await sendNotificationEmail({
      emailAccountId: "account-1",
      userEmail: "user@example.com",
      provider: "google",
      subject: "Your digest",
      sendViaResend: vi.fn(),
      renderHtml: async () => "<p>Hello</p>",
      logger: createTestLogger(),
      operationId: "digest_abc",
      beforeSend: vi.fn(),
    });

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
    expect(sendEmailWithHtml).toHaveBeenCalledTimes(1);
  });
});
