import { beforeEach, describe, expect, it, vi } from "vitest";
import { ActionType } from "@/generated/prisma/enums";
import {
  getAction,
  getEmailAccount,
  getMockMessage,
} from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import { fetchMessagesAndGenerateDraftWithConfidenceThreshold } from "@/utils/reply-tracker/generate-draft";
import { aiGenerateArgs } from "@/utils/ai/choose-rule/ai-choose-args";
import { getActionItemsWithAiArgs } from "./choose-args";

vi.mock("@/utils/reply-tracker/generate-draft", () => ({
  fetchMessagesAndGenerateDraftWithConfidenceThreshold: vi.fn(),
}));
vi.mock("@/utils/ai/choose-rule/ai-choose-args", () => ({
  aiGenerateArgs: vi.fn(),
}));
vi.mock("@/utils/mcp/tool-specs", () => ({
  getIntegrationToolSpec: vi.fn(),
  isAiFilledArgValue: vi.fn(),
}));

const logger = createScopedLogger("test");

const connectionError = Object.assign(new Error("connect ECONNREFUSED"), {
  code: "ECONNREFUSED",
});

function run(actions: ReturnType<typeof getAction>[]) {
  return getActionItemsWithAiArgs({
    message: getMockMessage(),
    emailAccount: {
      ...getEmailAccount(),
      draftReplyConfidence: "ALL_EMAILS",
    } as never,
    selectedRule: { id: "rule-1", actions } as never,
    client: {} as never,
    modelType: "default",
    logger,
  });
}

describe("getActionItemsWithAiArgs when the model is unavailable", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const draftAction = getAction({
    id: "draft-1",
    type: ActionType.DRAFT_EMAIL,
    content: null,
  });

  it("rethrows a draft generation outage so the email is retried", async () => {
    vi.mocked(
      fetchMessagesAndGenerateDraftWithConfidenceThreshold,
    ).mockRejectedValue(connectionError);

    await expect(run([draftAction])).rejects.toThrow("ECONNREFUSED");
  });

  it("still continues without a draft for other draft errors", async () => {
    vi.mocked(
      fetchMessagesAndGenerateDraftWithConfidenceThreshold,
    ).mockRejectedValue(new Error("Draft context missing"));

    await expect(run([draftAction])).resolves.toEqual([]);
  });

  it("propagates an outage while generating template args", async () => {
    vi.mocked(aiGenerateArgs).mockRejectedValue(connectionError);

    await expect(
      run([
        getAction({
          id: "label-1",
          type: ActionType.LABEL,
          label: "{{pick a label}}",
        }),
      ]),
    ).rejects.toThrow("ECONNREFUSED");
  });
});
