import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  AutomationJobRunStatus,
  MessagingProvider,
} from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { isActivePremium } from "@/utils/premium";
import { getUserPremium } from "@/utils/user/get";
import { createEmailProvider } from "@/utils/email/provider";
import { getAutomationJobMessage } from "@/utils/automation-jobs/message";
import { sendAutomationMessage } from "@/utils/automation-jobs/messaging";
import { executeAutomationJobRun } from "@/utils/automation-jobs/execute";
import { SafeError } from "@/utils/error";

vi.mock("@/utils/prisma");
vi.mock("@/utils/premium", () => ({
  isActivePremium: vi.fn(),
}));
vi.mock("@/utils/user/get", () => ({
  getUserPremium: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/automation-jobs/message", () => ({
  getAutomationJobMessage: vi.fn(),
}));
vi.mock("@/utils/automation-jobs/messaging", () => ({
  sendAutomationMessage: vi.fn(),
}));

const logger = createScopedLogger("automation-jobs-execute-test");
const mockGetUserPremium = vi.mocked(getUserPremium);
const mockIsActivePremium = vi.mocked(isActivePremium);
const mockCreateEmailProvider = vi.mocked(createEmailProvider);
const mockGetAutomationJobMessage = vi.mocked(getAutomationJobMessage);
const mockSendAutomationMessage = vi.mocked(sendAutomationMessage);

describe("executeAutomationJobRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetUserPremium.mockResolvedValue(null);
    mockIsActivePremium.mockReturnValue(true);
    mockCreateEmailProvider.mockResolvedValue({} as any);
    mockGetAutomationJobMessage.mockResolvedValue("Inbox summary");
    mockSendAutomationMessage.mockResolvedValue({
      channelId: "C456",
      messageId: "message-1",
    });
    prisma.automationJobRun.updateMany.mockResolvedValue({ count: 1 });
  });

  it("skips the run when the email account has been disconnected", async () => {
    prisma.automationJobRun.findUnique.mockResolvedValue(createRun());
    mockCreateEmailProvider.mockRejectedValue(
      new SafeError("No refresh token"),
    );

    const response = await executeAutomationJobRun({
      automationJobRunId: "run-1",
      logger,
    });

    expect(response.status).toBe(200);
    expect(mockSendAutomationMessage).not.toHaveBeenCalled();
    expect(prisma.automationJobRun.update).toHaveBeenCalledWith({
      where: { id: "run-1" },
      data: expect.objectContaining({
        status: AutomationJobRunStatus.SKIPPED,
        error: "Email account needs to be reconnected",
      }),
    });
  });
});

function createRun() {
  return {
    id: "run-1",
    automationJobId: "automation-job-1",
    status: AutomationJobRunStatus.PENDING,
    scheduledFor: new Date(),
    createdAt: new Date(),
    automationJob: {
      id: "automation-job-1",
      emailAccountId: "email-account-1",
      enabled: true,
      prompt: null,
      messagingChannel: {
        id: "channel-1",
        provider: MessagingProvider.SLACK,
        isConnected: true,
        accessToken: "test-slack-bot-token",
        botUserId: "B123",
        providerUserId: "U123",
        emailAccount: {
          id: "email-account-1",
          userId: "user-1",
          email: "user@example.com",
          name: "User",
          about: null,
          account: {
            provider: "google",
          },
          user: {
            aiProvider: null,
            aiModel: null,
            aiApiKey: null,
          },
        },
      },
    },
  } as any;
}
