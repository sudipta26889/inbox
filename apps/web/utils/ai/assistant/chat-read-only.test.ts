import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";

const { mockToolCallAgentStream } = vi.hoisted(() => ({
  mockToolCallAgentStream: vi.fn(
    (_options: { tools: Record<string, unknown>; messages: unknown[] }) => ({}),
  ),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/llms", () => ({
  toolCallAgentStream: mockToolCallAgentStream,
}));
vi.mock("@/utils/calendar/event-provider", () => ({
  hasUsableCalendarConnection: vi.fn().mockResolvedValue(false),
}));
vi.mock("@/utils/integration-action.server", () => ({
  isIntegrationActionEnabledForUserId: vi.fn().mockResolvedValue(false),
}));

import { aiProcessAssistantChat } from "./chat";

const WRITE_TOOLS = [
  "manageInbox",
  "createRule",
  "updateRule",
  "updateAssistantSettings",
  "updatePersonalInstructions",
  "saveMemory",
];

describe("aiProcessAssistantChat readOnly", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("offers a read-only run (an A2A peer) only the read tools", async () => {
    const tools = await runChat(true);

    expect(tools).toEqual([
      "getAccountOverview",
      "searchInbox",
      "readEmail",
      "searchMemories",
    ]);
  });

  it("keeps the write tools for interactive runs", async () => {
    const tools = await runChat(false);

    for (const tool of WRITE_TOOLS) expect(tools).toContain(tool);
  });
});

async function runChat(readOnly: boolean) {
  await aiProcessAssistantChat({
    messages: [{ role: "user", content: "What needs attention?" }],
    emailAccountId: "email-account-id",
    user: {
      ...getEmailAccount(),
      account: { provider: "google" },
    } as Parameters<typeof aiProcessAssistantChat>[0]["user"],
    readOnly,
    logger: createScopedLogger("assistant-chat-read-only-test"),
  });

  return Object.keys(mockToolCallAgentStream.mock.calls[0]![0].tools);
}
