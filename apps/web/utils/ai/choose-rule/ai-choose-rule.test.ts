import { beforeEach, describe, expect, it, vi } from "vitest";
import { getEmail, getEmailAccount } from "@/__tests__/helpers";
import { aiChooseRule } from "./ai-choose-rule";

const generateObjectSpy = vi.fn();

vi.mock("@/utils/llms", () => ({
  createGenerateObject: vi.fn(() => generateObjectSpy),
}));

vi.mock("@/utils/llms/model", () => ({
  getModel: vi.fn(() => ({
    provider: "anthropic",
    modelName: "claude-test",
    model: {},
    providerOptions: undefined,
  })),
}));

describe("aiChooseRule rule name resolution", () => {
  const candidateRules = [
    { name: "To Reply", instructions: "Needs a reply" },
    { name: "To Reply Later", instructions: "Reply when free" },
    { name: "Conversations", instructions: "Ongoing threads" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["Conversations", "Conversations"],
    ["conversations", "Conversations"],
    ["Conversations», ", "Conversations"],
    ["Conversations', ", "Conversations"],
    ["Conversations}, ", "Conversations"],
    ["Conversations», noMatchFound: false}", "Conversations"],
    ['Conversations"', "Conversations"],
    ["Conversations`", "Conversations"],
    ["To Reply Later',", "To Reply Later"],
    ["To Reply',", "To Reply"],
    ["Conversations latest_marker", "Conversations"],
    ["Conversations Ongoing threads", "Conversations"],
    ["To Reply Later extra words", "To Reply Later"],
    ["To Reply\tnow", "To Reply"],
  ])("resolves %j to %s", async (returnedName, expectedRule) => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: returnedName, noMatchFound: false },
    });

    const result = await chooseRule(candidateRules);

    expect(result.rules.map(({ rule }) => rule.name)).toEqual([expectedRule]);
  });

  it.each([
    "Conversation",
    "Conversationsarchive",
    "To Replying",
    "To",
    "x",
  ])("does not resolve %j to a different rule", async (returnedName) => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: returnedName, noMatchFound: false },
    });

    await expect(chooseRule(candidateRules)).rejects.toThrow(UNRESOLVED_ERROR);
  });

  it("resolves polluted names in multi-rule responses", async () => {
    generateObjectSpy.mockResolvedValue({
      object: {
        reasoning: "r",
        noMatchFound: false,
        matchedRules: [
          { ruleName: "Conversations},", isPrimary: true },
          { ruleName: "To Reply'", isPrimary: false },
        ],
      },
    });

    const result = await chooseRule(candidateRules, true);

    expect(result.rules).toEqual([
      { rule: candidateRules[2], isPrimary: true },
      { rule: candidateRules[0], isPrimary: false },
    ]);
  });
});

describe("aiChooseRule invalid rule selections", () => {
  const candidateRules = [
    { name: "Allowed A", instructions: "First" },
    { name: "Allowed B", instructions: "Second" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a single-rule response naming a rule that was not offered", async () => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: "Other", noMatchFound: false },
    });

    await expect(chooseRule(candidateRules)).rejects.toThrow(UNRESOLVED_ERROR);
  });

  it("rejects a multi-rule response where no returned rule was offered", async () => {
    generateObjectSpy.mockResolvedValue({
      object: {
        reasoning: "r",
        noMatchFound: false,
        matchedRules: [{ ruleName: "Other", isPrimary: true }],
      },
    });

    await expect(chooseRule(candidateRules, true)).rejects.toThrow(
      UNRESOLVED_ERROR,
    );
  });

  it("rejects a claimed match with no rule name in a single-rule response", async () => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: "", noMatchFound: false },
    });

    await expect(chooseRule(candidateRules)).rejects.toThrow(UNRESOLVED_ERROR);
  });

  it("rejects a claimed match with an empty multi-rule list", async () => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", noMatchFound: false, matchedRules: [] },
    });

    await expect(chooseRule(candidateRules, true)).rejects.toThrow(
      UNRESOLVED_ERROR,
    );
  });

  it("keeps the offered rules when only some returned names resolve", async () => {
    generateObjectSpy.mockResolvedValue({
      object: {
        reasoning: "r",
        noMatchFound: false,
        matchedRules: [
          { ruleName: "Allowed B", isPrimary: true },
          { ruleName: "Other", isPrimary: false },
        ],
      },
    });

    const result = await chooseRule(candidateRules, true);

    expect(result.rules).toEqual([
      { rule: candidateRules[1], isPrimary: true },
    ]);
  });

  it.each([
    false,
    true,
  ])("still returns no rules when the model reports no match (multi-rule: %s)", async (multiRuleSelectionEnabled) => {
    generateObjectSpy.mockResolvedValue({
      object: {
        reasoning: "Nothing fits",
        ruleName: null,
        noMatchFound: true,
        matchedRules: [],
      },
    });

    const result = await chooseRule(candidateRules, multiRuleSelectionEnabled);

    expect(result.rules).toEqual([]);
  });
});

const UNRESOLVED_ERROR = /did not resolve to any offered rule/i;

function chooseRule(
  candidateRules: { name: string; instructions: string }[],
  multiRuleSelectionEnabled = false,
) {
  return aiChooseRule({
    email: getEmail(),
    rules: candidateRules,
    emailAccount: getEmailAccount({ multiRuleSelectionEnabled }),
  });
}
