import { describe, expect, it, vi } from "vitest";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import {
  aiDraftReplyWithConfidence,
  repairDraftReplyText,
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

describe("repairDraftReplyText", () => {
  it("wraps plain multi-line email text as a lowest-confidence reply", () => {
    const text =
      "\n  Hi,\n\n1. Yes, Friday works.\n2. $500 is right.\n\nThanks\n";

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi,\n\n1. Yes, Friday works.\n2. $500 is right.\n\nThanks",
      confidence: "LOW",
    });
  });

  it("leaves a valid object as it is", () => {
    const text = '{"reply":"Hi","confidence":"MEDIUM"}';

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi",
      confidence: "MEDIUM",
    });
  });

  it("defaults a missing confidence to the lowest", () => {
    expect(JSON.parse(repairDraftReplyText('{"reply":"Hi"}'))).toEqual({
      reply: "Hi",
      confidence: "LOW",
    });
  });

  it("replaces an invalid confidence with the lowest", () => {
    const text = '{"reply":"Hi","confidence":"bogus"}';

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi",
      confidence: "LOW",
    });
  });

  it("keeps a valid confidence as it is", () => {
    const text = '{"reply":"Hi","confidence":"HIGH"}';

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi",
      confidence: "HIGH",
    });
  });

  it("unwraps JSON inside ```json fences", () => {
    const text = '```json\n{"reply":"Hi","confidence":"MEDIUM"}\n```';

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi",
      confidence: "MEDIUM",
    });
  });

  it("repairs JSON with a trailing comma", () => {
    const text = '{"reply":"Hi","confidence":"MEDIUM",}';

    expect(JSON.parse(repairDraftReplyText(text))).toEqual({
      reply: "Hi",
      confidence: "MEDIUM",
    });
  });

  it("keeps &, HTML-looking text and URLs literally", () => {
    const text = "Tom & Jerry <b>x</b> see https://example.com/a?b=1&c=2";

    expect(JSON.parse(repairDraftReplyText(text)).reply).toBe(text);
  });

  it("treats a JSON object without a string reply as plain text", () => {
    const text = '{"answer":"Hi"}';

    expect(JSON.parse(repairDraftReplyText(text)).reply).toBe(text);
  });

  it("returns whitespace-only text unchanged, so validation still fails", () => {
    expect(repairDraftReplyText("   ")).toBe("   ");
    expect(repairDraftReplyText("")).toBe("");
  });
});

describe("aiDraftReplyWithConfidence prompt and repair wiring", () => {
  it("passes the draft repair function and the plain-text reply rule", async () => {
    mockGenerateObject.mockResolvedValue({
      object: { reply: "Hello there", confidence: "MEDIUM" },
      usage: undefined,
    });

    await aiDraftReplyWithConfidence({
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

    const options = mockGenerateObject.mock.calls[0][0];
    expect(options.instructions).not.toContain("Return plain text only.");
    expect(options.instructions).toContain("The reply field is plain text only.");
    expect(options.repairText).toBeTypeOf("function");
    const repaired = await options.repairText({
      text: "Hi, plain text",
    });
    expect(JSON.parse(repaired).reply).toBe("Hi, plain text");
  });
});
