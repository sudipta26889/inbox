import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { env } from "@/env";
import { DigestStatus } from "@/generated/prisma/enums";
import { SendNotApprovedError } from "@/utils/mail/send-approval";

vi.mock("@/utils/prisma");
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return { ...actual, env: { ...actual.env } };
});

const {
  mockCreateEmailProvider,
  mockCreateUnsubscribeToken,
  mockClaim,
  mockHasLive,
  mockRenew,
  mockApprove,
} = vi.hoisted(() => ({
  mockCreateEmailProvider: vi.fn(),
  mockCreateUnsubscribeToken: vi.fn(),
  mockClaim: vi.fn(),
  mockHasLive: vi.fn(),
  mockRenew: vi.fn(),
  mockApprove: vi.fn(),
}));

vi.mock("@/utils/middleware", async () => {
  const {
    createWithEmailAccountTestMiddleware,
    createWithErrorTestMiddleware,
  } = await vi.importActual<typeof import("@/__tests__/helpers")>(
    "@/__tests__/helpers",
  );
  return {
    ...createWithErrorTestMiddleware(),
    ...createWithEmailAccountTestMiddleware({
      auth: {
        email: "user@example.com",
        emailAccountId: "email-account-id",
        userId: "user-1",
      },
    }),
  };
});

vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: (...args: unknown[]) => mockCreateEmailProvider(...args),
}));

vi.mock("@/utils/unsubscribe", () => ({
  createUnsubscribeToken: (...args: unknown[]) =>
    mockCreateUnsubscribeToken(...args),
}));

vi.mock("@/utils/digest/schedule", () => ({
  getDigestScheduleProgression: () => ({ lastOccurrenceAt: new Date() }),
  isDigestScheduleDue: () => true,
}));

vi.mock("@/utils/digest/claim-pending-digests", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/utils/digest/claim-pending-digests")
    >();
  return {
    ...actual,
    claimPendingDigests: (...args: unknown[]) => mockClaim(...args),
    hasLiveProcessingDigest: (...args: unknown[]) => mockHasLive(...args),
    renewDigestClaim: (...args: unknown[]) => mockRenew(...args),
  };
});

vi.mock("@/utils/mail/send-approval", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/utils/mail/send-approval")>();
  return {
    ...actual,
    approveSendOperation: (...args: unknown[]) => mockApprove(...args),
  };
});

import { POST } from "./route";

const claim = { digestIds: ["d2", "d1"], claimedAt: new Date() };
const approval = { emailAccountId: "email-account-id" } as const;

describe("digest route single approval", () => {
  const sendEmailWithHtml = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    env.RESEND_API_KEY = undefined;
    mockCreateUnsubscribeToken.mockResolvedValue("token");
    mockHasLive.mockResolvedValue(false);
    mockClaim.mockResolvedValue(claim);
    mockRenew.mockResolvedValue(claim);
    mockApprove.mockResolvedValue({ approval, edits: {}, attachments: [] });
    sendEmailWithHtml.mockResolvedValue(undefined);
    mockCreateEmailProvider.mockResolvedValue({
      sendEmailWithHtml,
      getMessagesBatch: vi.fn().mockResolvedValue([
        {
          id: "m1",
          headers: { from: "Acme <a@acme.com>", subject: "Hello" },
        },
      ]),
    });

    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      digestSendEmail: true,
      account: { provider: "google", refresh_token: "r" },
    } as any);
    prisma.schedule.findUnique.mockResolvedValue({ id: "s1" } as any);
    prisma.messagingChannel.findMany.mockResolvedValue([]);
    prisma.digest.findMany.mockResolvedValue([
      {
        id: "d1",
        items: [
          {
            messageId: "m1",
            content: JSON.stringify({ content: "body" }),
            action: { executedRule: { rule: { name: "Newsletter" } } },
          },
        ],
      },
    ] as any);
    prisma.$transaction.mockResolvedValue([] as any);
  });

  const post = () =>
    POST(
      new NextRequest("http://localhost:3000/api/resend/digest", {
        method: "POST",
        body: JSON.stringify({ emailAccountId: "email-account-id" }),
      }),
    );

  it("does nothing while a digest is awaiting approval", async () => {
    mockHasLive.mockResolvedValue(true);

    const body = await (await post()).json();

    expect(body.message).toMatch(/awaiting approval/);
    expect(mockClaim).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(prisma.schedule.update).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("does not send or mark rows when the claim is lost after approval", async () => {
    // First renew (before approval) works, the one after approval fails.
    mockRenew.mockResolvedValueOnce(claim).mockResolvedValueOnce(null);

    const body = await (await post()).json();

    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(sendEmailWithHtml).not.toHaveBeenCalled();
    expect(body.message).toBe("Digest processing claim was lost");
    expect(prisma.digest.updateMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("marks the digest declined and advances the schedule when the reviewer says no", async () => {
    mockApprove.mockRejectedValue(
      new SendNotApprovedError(
        "Email sending denied by human reviewer",
        "REJECTED",
      ),
    );

    const response = await post();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      message: "Digest declined by reviewer",
    });
    expect(sendEmailWithHtml).not.toHaveBeenCalled();
    expect(prisma.schedule.update).toHaveBeenCalledTimes(1);
    expect(prisma.digest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: DigestStatus.DECLINED },
      }),
    );
    expect(prisma.digest.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: DigestStatus.FAILED },
      }),
    );
  });

  it("marks the digest failed and keeps the schedule due when approval was unavailable", async () => {
    mockApprove.mockRejectedValue(
      new SendNotApprovedError(
        "Email not sent: the approval service is unavailable.",
      ),
    );

    await post();

    expect(sendEmailWithHtml).not.toHaveBeenCalled();
    expect(prisma.schedule.update).not.toHaveBeenCalled();
    expect(prisma.digest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: DigestStatus.FAILED } }),
    );
    expect(prisma.digest.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: DigestStatus.DECLINED } }),
    );
  });

  it("asks once and sends once with the issued approval", async () => {
    const body = await (await post()).json();

    expect(body.message).toBe("Digest email sent successfully");
    expect(mockApprove).toHaveBeenCalledTimes(1);
    expect(mockApprove).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "send_email",
        emailAccountId: "email-account-id",
        operationId: expect.stringMatching(/^digest_[0-9a-f]{64}$/),
      }),
    );
    expect(sendEmailWithHtml).toHaveBeenCalledTimes(1);
    expect(sendEmailWithHtml).toHaveBeenCalledWith(
      expect.objectContaining({ to: "user@example.com" }),
      { approval },
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});
