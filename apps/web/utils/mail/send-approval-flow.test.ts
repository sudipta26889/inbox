import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createMockEmailProvider } from "@/utils/__mocks__/email-provider";
import { EmailSendOperationStatus } from "@/generated/prisma/enums";
import { Prisma, type ScheduledEmail } from "@/generated/prisma/client";
import { createScopedLogger } from "@/utils/logger";
import { SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import { executeDurableEmailSend } from "@/utils/email/durable-email-send";
import {
  cancelHeldEmail,
  holdEmailForUndo,
  processScheduledEmail,
  scheduleEmail,
} from "@/utils/scheduled-email/service";
import { publishToQstashAt } from "@/utils/upstash";
import {
  approveSendOperation,
  requireSendApproval,
  type SendApproval,
} from "./send-approval";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/upstash", () => ({ publishToQstashAt: vi.fn() }));
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
    wasDenied: (decision: { action: string }) =>
      ["DENY", "REJECTED", "EXPIRED", "ERROR"].includes(decision.action),
    shouldRevise: (decision: { action: string }) =>
      decision.action === "REVISE_REQUESTED",
  },
}));

const logger = createScopedLogger("send-approval-flow-test");
const now = new Date("2026-09-05T10:00:00Z");
const mutationId = "7f0c3b9e-2c1d-4d6e-9b2a-1f0e5d4c3b2a";
// A retry replays the same envelope, queue time included.
const queuedAt = Date.now();
const email = {
  to: "person@example.com",
  subject: "Reply",
  messageHtml: "<p>Hello</p>",
};

describe("DharaHIL gate on durable and scheduled sends", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    memo.clear();
    mockRunApprovalLoop.mockResolvedValue({ action: "APPROVED" });
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
      sentMessageOpenTrackingEnabled: false,
      account: { provider: "google" },
    } as never);
    prisma.scheduledEmail.findUnique.mockResolvedValue(null);
    prisma.emailSendOperation.findUnique.mockResolvedValue(null);
    prisma.emailSendOperation.create.mockImplementation((async ({
      data,
    }: {
      data: { payloadHash: string };
    }) => ({
      id: "operation",
      status: EmailSendOperationStatus.PROCESSING,
      ...data,
    })) as never);
  });

  it("asks before committing, keyed by the operation id, and sends with that approval", async () => {
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn().mockResolvedValue({
        messageId: "sent-1",
        threadId: "thread",
      }),
    });

    const outcome = await sendDurably(provider);

    expect(outcome.status).toBe("applied");
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
    const [call] = mockRunApprovalLoop.mock.calls[0];
    expect(call.context.idempotencyKey).toBe(`inbox_account_${mutationId}`);
    expect(
      mockRunApprovalLoop.mock.invocationCallOrder[0] <
        prisma.emailSendOperation.create.mock.invocationCallOrder[0],
    ).toBe(true);

    // The provider gate accepts the approval it was handed, without a card.
    const { approval } = vi.mocked(provider.sendEmailWithHtml).mock
      .calls[0][1] as { approval: SendApproval };
    await requireSendApproval({
      operation: "send_email",
      emailAccountId: "account",
      to: email.to,
      approval,
    });
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  it("sends a retried approved operation once and raises no second card", async () => {
    const sendEmailWithHtml = vi
      .fn()
      .mockRejectedValueOnce(new SafeError("Try again"))
      .mockResolvedValue({ messageId: "sent-1", threadId: "thread" });
    const provider = createMockEmailProvider({ sendEmailWithHtml });

    // The failed attempt released its send record, so the retry starts over.
    expect((await sendDurably(provider)).status).toBe("rejected");
    expect((await sendDurably(provider)).status).toBe("applied");

    prisma.emailSendOperation.findUnique.mockResolvedValue({
      id: "operation",
      status: EmailSendOperationStatus.SENT,
      payloadHash: prisma.emailSendOperation.create.mock.calls[1][0].data
        .payloadHash as string,
      result: { messageId: "sent-1" },
    } as never);
    expect((await sendDurably(provider)).status).toBe("already_applied");

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
    expect(sendEmailWithHtml).toHaveBeenCalledTimes(2);
  });

  it("asks again when the same operation id carries a different email", async () => {
    await approveSendOperation({
      operation: "send_email",
      emailAccountId: "account",
      operationId: mutationId,
      payloadHash: "a",
      to: email.to,
    });
    await approveSendOperation({
      operation: "send_email",
      emailAccountId: "account",
      operationId: mutationId,
      payloadHash: "b",
      to: email.to,
    });

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(2);
  });

  it("does not accept a look-alike approval it never issued", async () => {
    await requireSendApproval({
      operation: "send_email",
      emailAccountId: "account",
      to: email.to,
      approval: { emailAccountId: "account", operationId: mutationId },
    });

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  it("rejects a denied send without committing or sending it", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "REJECTED" });
    const provider = createMockEmailProvider();

    const outcome = await sendDurably(provider);

    expect(outcome.status).toBe("rejected");
    expect(prisma.emailSendOperation.create).not.toHaveBeenCalled();
    expect(provider.sendEmailWithHtml).not.toHaveBeenCalled();
  });

  it("asks at scheduling time, with the time, and not again when the email goes out", async () => {
    // The durable send refuses month-old queue times, so use real time here.
    const sendAt = new Date(Date.now() + 60 * 60 * 1000);
    const input = scheduledInput(sendAt.toISOString());
    prisma.scheduledEmail.create.mockResolvedValue(scheduledRow(input));

    await scheduleEmail("account", input);

    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
    const [call] = mockRunApprovalLoop.mock.calls[0];
    expect(call.toolName).toBe("schedule_email");
    expect(call.toolArgs.sendAt).toBe(sendAt.toISOString());

    // 3 am: the cron sends it.
    const provider = createMockEmailProvider({
      sendEmailWithHtml: vi.fn().mockResolvedValue({
        messageId: "sent-1",
        threadId: "thread",
      }),
    });
    vi.mocked(createEmailProvider).mockResolvedValue(provider);
    prisma.scheduledEmail.findUnique
      .mockResolvedValueOnce(scheduledRow(input, { sendAt }))
      .mockResolvedValueOnce(scheduledRow(input, { status: "PROCESSING" }));
    prisma.scheduledEmail.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailAccount.findUniqueOrThrow.mockResolvedValue({
      account: { provider: "google" },
    } as never);
    prisma.emailSendOperation.findUniqueOrThrow.mockResolvedValue({
      processingStartedAt: sendAt,
    } as never);

    await processScheduledEmail("id", logger, sendAt);

    expect(provider.sendEmailWithHtml).toHaveBeenCalledTimes(1);
    expect(mockRunApprovalLoop).toHaveBeenCalledTimes(1);
  });

  it("does not send a scheduled email the human rejected", async () => {
    mockRunApprovalLoop.mockResolvedValue({ action: "REJECTED" });

    await expect(
      scheduleEmail("account", scheduledInput("2026-09-06T03:00:00.000Z"), now),
    ).rejects.toThrow(/denied/);
    expect(prisma.scheduledEmail.create).not.toHaveBeenCalled();
  });

  it("keeps undo working while the approval card is open", async () => {
    const input = scheduledInput(null);
    // The user presses Undo while the card is still open.
    mockRunApprovalLoop.mockImplementation(async () => {
      await cancelHeldEmail("account", input.clientMutationId);
      return { action: "APPROVED" };
    });
    prisma.scheduledEmail.updateMany.mockResolvedValue({ count: 0 });
    prisma.scheduledEmail.create
      .mockResolvedValueOnce(scheduledRow(input, { status: "CANCELLED" }))
      .mockRejectedValueOnce(
        new Prisma.PrismaClientKnownRequestError("duplicate", {
          code: "P2002",
          clientVersion: "test",
        }),
      );
    prisma.scheduledEmail.findUniqueOrThrow.mockResolvedValue(
      scheduledRow(input, { status: "CANCELLED", heldForUndo: true }),
    );

    const held = await holdEmailForUndo({
      emailAccountId: "account",
      input,
      sendAt: now,
      logger,
    });

    expect(held.status).toBe("CANCELLED");
    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("raises no card for a send that was undone before it reached the server", async () => {
    const input = scheduledInput(null);
    prisma.scheduledEmail.findUnique.mockResolvedValue(
      scheduledRow(input, { status: "CANCELLED", heldForUndo: true }),
    );

    await holdEmailForUndo({
      emailAccountId: "account",
      input,
      sendAt: now,
      logger,
    });

    expect(mockRunApprovalLoop).not.toHaveBeenCalled();
  });
});

function sendDurably(provider: ReturnType<typeof createMockEmailProvider>) {
  return executeDurableEmailSend({
    logger,
    emailAccountId: "account",
    getEmailProvider: async () => provider,
    provider: "google",
    input: {
      mutationId,
      queuedAt,
      threadId: "thread",
      messageIds: ["message"],
      email,
    },
  });
}

function scheduledInput(sendAt: string | null) {
  return {
    clientMutationId: "827f1b38-2032-4bfd-bc2c-cbba02746b04",
    threadId: "thread",
    messageIds: ["message"],
    email,
    sendAt,
    remindAt: null,
  };
}

function scheduledRow(
  input: ReturnType<typeof scheduledInput>,
  overrides: Partial<ScheduledEmail> = {},
): ScheduledEmail {
  return {
    id: "id",
    draftMessageIds: [],
    emailAccountId: "account",
    threadId: "thread",
    clientMutationId: input.clientMutationId,
    payload: input,
    payloadHash: "hash",
    status: "PENDING",
    sendAt: now,
    createdAt: now,
    updatedAt: now,
    processingStartedAt: null,
    executionQueuedAt: null,
    sentAt: null,
    error: null,
    remindAt: null,
    reminderStatus: "NONE",
    reminderStartedAt: null,
    heldForUndo: false,
    ...overrides,
  };
}
