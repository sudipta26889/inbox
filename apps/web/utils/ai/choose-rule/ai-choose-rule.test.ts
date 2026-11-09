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
  ])("resolves %j to %s", async (returnedName, expectedRule) => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: returnedName, noMatchFound: false },
    });

    const result = await chooseRule(candidateRules);

    expect(result.rules.map(({ rule }) => rule.name)).toEqual([expectedRule]);
  });

  it.each([
    "Conversation",
    "Conversations archive",
    "To",
  ])("does not resolve %j to a different rule", async (returnedName) => {
    generateObjectSpy.mockResolvedValue({
      object: { reasoning: "r", ruleName: returnedName, noMatchFound: false },
    });

    const result = await chooseRule(candidateRules);

    expect(result.rules).toEqual([]);
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
