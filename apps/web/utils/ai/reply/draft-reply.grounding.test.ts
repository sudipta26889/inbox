import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import {
  aiDraftReplyWithConfidence,
  hasDraftPlaceholder,
} from "@/utils/ai/reply/draft-reply";

const { mockGenerateObject } = vi.hoisted(() => ({
  mockGenerateObject: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/llms/model", () => ({
  getModel: vi.fn(() => ({
    provider: "openai",
    modelName: "test-model",
    model: {},
    providerOptions: undefined,
    fallbackModels: [],
  })),
}));
vi.mock("@/utils/llms/index", () => ({
  createGenerateObject: vi.fn(() => mockGenerateObject),
}));

describe("hasDraftPlaceholder", () => {
  it.each([
    ["[confirm: 4 pm?]", true],
    ["[your answer: x]", true],
    ["Thanks. [confirm: is the fee $500?] [confirm: are we booked?]", true],
    ["see [docs](https://x.y)", false],
    ["no brackets", false],
    ["[]", false],
    ["[a]", false],
    ["[ab]", true],
    [`[${"x".repeat(200)}]`, true],
    [`[${"x".repeat(201)}]`, false],
  ])("%j -> %s", (reply, expected) => {
    expect(hasDraftPlaceholder(reply)).toBe(expected);
  });

  it("still finds a placeholder next to a markdown link", () => {
    expect(hasDraftPlaceholder("[docs](https://x.y) and [confirm: ok?]")).toBe(
      true,
    );
  });
});

describe("draft grounding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells the model to ground every fact and to leave placeholders, not guess", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { reply: "Hello", confidence: "STANDARD" },
    });

    await draft();

    const system: string = mockGenerateObject.mock.calls[0][0].system;
    expect(system).not.toContain("would most likely give");
    expect(system).not.toContain("Bad: \"I'll confirm");
    expect(system).not.toContain("Never mention your own context");
    expect(system).not.toContain("relies on a guess about the user's answer");
    expect(system).toContain("Never invent them");
    expect(system).toContain("square brackets");
    expect(system).toContain("Never use a placeholder for the user's name.");
  });

  it("forces the lowest confidence when the reply has a placeholder", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        reply: "Thanks. [confirm: is the fee $500?]",
        confidence: "HIGH_CONFIDENCE",
      },
    });

    const result = await draft();

    expect(result.confidence).toBe("ALL_EMAILS");
  });

  it("keeps the model's confidence when there is no placeholder", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { reply: "Sounds good.", confidence: "HIGH_CONFIDENCE" },
    });

    const result = await draft();

    expect(result.confidence).toBe("HIGH_CONFIDENCE");
  });

  it("does not treat a markdown link as a placeholder", async () => {
    mockGenerateObject.mockResolvedValue({
      object: {
        reply: "See [the docs](https://example.com/docs).",
        confidence: "HIGH_CONFIDENCE",
      },
    });

    const result = await draft();

    expect(result.confidence).toBe("HIGH_CONFIDENCE");
  });
});

function draft() {
  return aiDraftReplyWithConfidence({
    messages: [{ ...getEmail(), to: "me@example.com" }],
    emailAccount: getEmailAccount(),
    knowledgeBaseContent: null,
    emailHistorySummary: null,
    emailHistoryContext: null,
    calendarAvailability: null,
    writingStyle: null,
    mcpContext: null,
    meetingContext: null,
  });
}
