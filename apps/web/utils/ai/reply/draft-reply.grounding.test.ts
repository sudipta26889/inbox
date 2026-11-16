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

describe("draft commitments", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateObject.mockResolvedValue({
      object: { reply: "Hello", confidence: "STANDARD" },
    });
  });

  it("forbids derived numbers and talk about missing context, using placeholders instead", async () => {
    await draft();

    const system: string = mockGenerateObject.mock.calls[0][0].system;
    expect(system).toContain("Never calculate, estimate, round or derive");
    expect(system).toContain("[your answer: the day rate?]");
    expect(system).toContain("Never mention your own context");
    expect(system).toContain("use a placeholder instead");
  });

  it("forbids accepting or promising for the user, with the free-slot and past-email cases", async () => {
    await draft();

    const system: string = mockGenerateObject.mock.calls[0][0].system;
    expect(system).toContain("Never accept, agree to, decide or promise");
    expect(system).toContain("A free calendar slot is not agreement");
    expect(system).toContain("A pattern in past emails is not a commitment");
    expect(system).toContain(
      "Facts found in the provided past emails or knowledge base may be stated; decisions and commitments may not.",
    );
  });

  const slots = [{ start: "2026-11-20 16:00", end: "2026-11-20 17:00" }];

  it("offers free slots only inside a confirm placeholder, without a booking link", async () => {
    await draft({
      calendarAvailability: { noAvailability: false, suggestedTimes: slots },
    });

    const prompt: string = mockGenerateObject.mock.calls[0][0].prompt;
    expect(prompt).toContain("2026-11-20 16:00 to 2026-11-20 17:00");
    expect(prompt).toContain("only inside a [confirm:");
    expect(prompt).toContain("never as an acceptance");
    expect(prompt).not.toContain("Use these time slots");
    expect(prompt).not.toContain("optionally suggest");
  });

  it("says the same with a booking link, and still leads with the link", async () => {
    await draft({
      calendarAvailability: { noAvailability: false, suggestedTimes: slots },
      calendarBookingLink: "https://cal.example.com/me",
    });

    const prompt: string = mockGenerateObject.mock.calls[0][0].prompt;
    expect(prompt).toContain("Lead with the booking link");
    expect(prompt).toContain("only inside a [confirm:");
    expect(prompt).not.toContain("optionally suggest");
  });
});

function draft(
  overrides: {
    calendarAvailability?: Parameters<
      typeof aiDraftReplyWithConfidence
    >[0]["calendarAvailability"];
    calendarBookingLink?: string;
  } = {},
) {
  return aiDraftReplyWithConfidence({
    messages: [{ ...getEmail(), to: "me@example.com" }],
    emailAccount: {
      ...getEmailAccount(),
      calendarBookingLink: overrides.calendarBookingLink ?? null,
    },
    knowledgeBaseContent: null,
    emailHistorySummary: null,
    emailHistoryContext: null,
    calendarAvailability: overrides.calendarAvailability ?? null,
    writingStyle: null,
    mcpContext: null,
    meetingContext: null,
  });
}
