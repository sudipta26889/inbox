import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";

const { mockToolCallAgentStream } = vi.hoisted(() => ({
  mockToolCallAgentStream: vi.fn(
    (options: { tools: Record<string, unknown> }) => {
      lastTools = Object.keys(options.tools);
      return {};
    },
  ),
}));

let lastTools: string[] = [];

vi.mock("server-only", () => ({}));
vi.mock("@/utils/llms", () => ({
  toolCallAgentStream: mockToolCallAgentStream,
}));
vi.mock("@/utils/prisma", () => ({
  default: {
    rule: { findMany: vi.fn().mockResolvedValue([]) },
    chatMemory: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

import { aiProcessAssistantChat } from "./chat";

const WRITE_TOOLS = [
  "manageInbox",
  "createRule",
  "updateRuleActions",
  "updateAssistantSettings",
  "updatePersonalInstructions",
  "saveMemory",
  "createOrGetLabel",
];

async function runChat(readOnly: boolean) {
  await aiProcessAssistantChat({
    messages: [{ role: "user", content: "What needs attention?" }],
    emailAccountId: "email-account-id",
    user: {
      ...getEmailAccount(),
      account: { provider: "google" },
    } as Parameters<typeof aiProcessAssistantChat>[0]["user"],
    readOnly,
    logger: createScopedLogger("assistant-chat-test"),
  });

  return lastTools;
}

describe("aiProcessAssistantChat", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exposes no write tools to unattended read-only runs", async () => {
    const tools = await runChat(true);

    expect(tools).toEqual([
      "getAccountOverview",
      "searchInbox",
      "readEmail",
      "searchMemories",
    ]);
  });

  it("exposes write tools to interactive runs", async () => {
    const tools = await runChat(false);

    for (const tool of WRITE_TOOLS) {
      expect(tools).toContain(tool);
    }
  });
});
