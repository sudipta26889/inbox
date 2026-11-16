import { describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/ai/assistant/get-inbox-stats-for-chat-context", () => ({
  getInboxStatsForChatContext: vi.fn(async () => ({ total: 3, unread: 1 })),
}));
vi.mock("@/utils/ai/assistant/get-recent-chat-memories", () => ({
  getRecentChatMemories: vi.fn(async () => [
    { content: "Digest at 5am", date: "2026-09-01" },
  ]),
}));
vi.mock("@/utils/longmemory/client", () => ({
  recallMemoriesOrNone: vi.fn(async () => [
    { content: "digest at 5am", score: 0.9 },
    { content: "Ships with Bluedart", score: 0.8 },
  ]),
}));

import { loadAgentContext, memoryQueryFromParts } from "./agent-context";

describe("loadAgentContext", () => {
  it("merges recalled and recent memories, deduped, every one with a date string", async () => {
    const { inboxStats, memories } = await loadAgentContext({
      emailAccountId: "acc",
      provider: "google",
      surface: "test",
      query: "when is my digest?",
      logger: createTestLogger(),
    });

    expect(inboxStats).toEqual({ total: 3, unread: 1 });
    expect(memories).toEqual([
      { content: "digest at 5am", date: "" },
      { content: "Ships with Bluedart", date: "" },
    ]);
  });

  it("builds the recall query from text parts only, capped at 500 chars", () => {
    expect(
      memoryQueryFromParts([
        { type: "text", text: "a".repeat(600) },
        { type: "file", text: "ignored" },
      ]),
    ).toHaveLength(500);
    expect(memoryQueryFromParts([{ type: "file" }])).toBeUndefined();
  });
});
