import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailProvider } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";

const { mockAiGenerateAutomationCheckInMessage } = vi.hoisted(() => {
  const mockAiGenerateAutomationCheckInMessage = vi.fn();
  return { mockAiGenerateAutomationCheckInMessage };
});

vi.mock("server-only", () => ({}));
vi.mock("@/utils/ai/automation-jobs/generate-check-in-message", () => ({
  aiGenerateAutomationCheckInMessage: mockAiGenerateAutomationCheckInMessage,
}));

import { getAutomationJobMessage } from "./message";

const logger = createScopedLogger("automation-jobs-message-test");
const emailAccountId = "email-account-id";

describe("getAutomationJobMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses an LLM-generated message when a custom prompt is set", async () => {
    mockAiGenerateAutomationCheckInMessage.mockResolvedValueOnce(
      "Three urgent client emails need your review. Want to triage them now?",
    );

    const message = await getAutomationJobMessage({
      prompt: "Only include urgent client messages.",
      emailAccountId,
      emailProvider: getMockEmailProvider({ unread: 3, total: 12 }),
      logger,
    });

    expect(message).toBe(
      "Three urgent client emails need your review. Want to triage them now?",
    );
    expect(mockAiGenerateAutomationCheckInMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId,
        prompt: "Only include urgent client messages.",
        logger,
      }),
    );
  });

  it("throws instead of echoing the prompt when generation fails", async () => {
    mockAiGenerateAutomationCheckInMessage.mockRejectedValueOnce(
      new Error("LLM unavailable"),
    );

    await expect(
      getAutomationJobMessage({
        prompt: "Focus on priorities.",
        emailAccountId,
        emailProvider: getMockEmailProvider({ unread: 5, total: 20 }),
        logger,
      }),
    ).rejects.toThrow("LLM unavailable");
  });

  it("uses the non-LLM fallback flow when no custom prompt is provided", async () => {
    const message = await getAutomationJobMessage({
      prompt: null,
      emailAccountId,
      emailProvider: getMockEmailProvider({ unread: 0, total: 4 }),
      logger,
    });

    expect(message).toBe(
      "Your inbox looks clear right now. Want me to keep monitoring and ping again later?",
    );
    expect(mockAiGenerateAutomationCheckInMessage).not.toHaveBeenCalled();
  });
});
