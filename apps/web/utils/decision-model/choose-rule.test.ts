import { afterEach, describe, expect, it, vi } from "vitest";
import { getEmailAccount } from "@/__tests__/helpers";
import { SystemType } from "@/generated/prisma/enums";
import type { EmailForLLM } from "@/utils/types";
import { decideRule } from "./choose-rule";
import { DecisionUncertainError } from "./decision-model";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));
vi.mock("@/env", () => ({ env: {} }));

const config = {
  provider: "litellm" as const,
  modelId: "typesafe/jev-latest",
  url: "http://nuc.lan:4000/v1/systemone",
  apiKey: "sk-gateway",
};

const email: EmailForLLM = {
  id: "m1",
  from: "deals@shop.example",
  to: "owner@company.example",
  subject: "50% off this weekend",
  content: "Our biggest sale of the year.",
};

const rules = [
  {
    id: "r-news",
    name: "Newsletter",
    instructions: "Newsletters",
    systemType: SystemType.NEWSLETTER,
  },
  {
    id: "r-mkt",
    name: "Marketing",
    instructions: "Promotions",
    systemType: SystemType.MARKETING,
  },
  {
    id: "r-reply",
    name: "To Reply",
    instructions: "Needs a reply",
    systemType: SystemType.TO_REPLY,
  },
  {
    id: "r-custom",
    name: "Invoices",
    instructions: "Supplier invoices",
    systemType: null,
  },
];

describe("decideRule", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the confidently chosen rule as primary", async () => {
    stubJev("Invoices", { Invoices: 0.97, None: 0.03 }, 0.96);
    const result = await decide();
    expect(result.rules).toEqual([{ rule: rules[3], isPrimary: true }]);
  });

  it("returns no rules when Jev confidently picks None", async () => {
    stubJev("None", { None: 0.98 }, 0.97);
    await expect(decide()).resolves.toMatchObject({ rules: [] });
  });

  it("escalates a low-confidence choice", async () => {
    stubJev("Invoices", { Invoices: 0.6, None: 0.4 }, 0.5);
    await expect(decide()).rejects.toBeInstanceOf(DecisionUncertainError);
  });

  it("lets bulk mail spread across content rules outvote a conversation", async () => {
    // To Reply is the single top answer, but Newsletter + Marketing together
    // outweigh it, so the strongest content rule wins.
    stubJev(
      "To Reply",
      { "To Reply": 0.02, Newsletter: 0.0, Marketing: 0.98 },
      0.98,
    );
    const result = await decide();
    expect(result.rules[0]?.rule.id).toBe("r-mkt");
  });
});

function decide() {
  return decideRule({ config, email, emailAccount: getEmailAccount(), rules });
}

function stubJev(
  choice: string,
  probabilities: Record<string, number>,
  confidence: number,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      Response.json({
        model: "jev-1.13.0",
        answers: {
          __rule_choice__: {
            type: "choice",
            choice,
            confidence,
            probabilities,
          },
        },
        usage: { input_tokens: 500, output_tokens: 10 },
      }),
    ),
  );
}
