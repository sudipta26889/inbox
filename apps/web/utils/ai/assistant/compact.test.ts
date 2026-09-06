import { describe, expect, it, vi } from "vitest";
import type { ModelMessage } from "ai";

vi.mock("@/utils/llms/model", () => ({
  getModel: vi.fn(),
}));

vi.mock("@/utils/llms", () => ({
  createGenerateText: vi.fn(),
  createGenerateObject: vi.fn(),
}));

import { estimateTokens, shouldCompact } from "@/utils/ai/assistant/compact";

describe("chat compaction thresholds", () => {
  it("estimates tokens across text, tool input, and tool result", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: "abcd",
      },
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "1234",
          },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "searchInbox",
            input: { query: "status" },
          },
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "searchInbox",
            output: { type: "json", value: { total: 2 } },
          },
        ],
      },
    ];

    expect(estimateTokens(messages)).toBe(
      Math.ceil(
        ("abcd".length +
          "1234".length +
          JSON.stringify({ query: "status" }).length +
          JSON.stringify({ total: 2 }).length) /
          4,
      ),
    );
  });

  /**
   * `output` is a tagged union and each arm carries its payload differently.
   * Counting the wrapper instead of the value would fold the tag and provider
   * options into the estimate; missing an arm would silently count zero, which
   * is the bug this whole branch was fixed for.
   */
  it.each([
    [
      "text",
      { type: "text" as const, value: "hello there" },
      "hello there".length,
    ],
    [
      "json",
      { type: "json" as const, value: { a: 1 } },
      JSON.stringify({ a: 1 }).length,
    ],
    [
      "error-text",
      { type: "error-text" as const, value: "boom" },
      "boom".length,
    ],
    [
      "execution-denied",
      { type: "execution-denied" as const, reason: "nope" },
      JSON.stringify({ type: "execution-denied", reason: "nope" }).length,
    ],
  ])("counts a %s tool output", (_name, output, expectedChars) => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "searchInbox",
            output,
          },
        ],
      },
    ];

    expect(estimateTokens(messages)).toBe(Math.ceil(expectedChars / 4));
  });

  it("uses a single threshold for all providers", () => {
    const exactlyThreshold: ModelMessage[] = [
      {
        role: "user",
        content: "a".repeat(320_000),
      },
    ];

    const overThreshold: ModelMessage[] = [
      {
        role: "user",
        content: "a".repeat(320_004),
      },
    ];

    expect(shouldCompact(exactlyThreshold)).toBe(false);
    expect(shouldCompact(overThreshold)).toBe(true);
  });
});
