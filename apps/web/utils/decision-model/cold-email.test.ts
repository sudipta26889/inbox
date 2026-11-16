import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createTestLogger,
  getEmail,
  getEmailAccount,
} from "@/__tests__/helpers";

const runDecisionModelMock = vi.hoisted(() => vi.fn());
vi.mock("./decision-model", async (importActual) => ({
  ...(await importActual<typeof import("./decision-model")>()),
  runDecisionModel: runDecisionModelMock,
}));

import { decideColdEmail } from "./cold-email";
import { DecisionUncertainError } from "./decision-model";

const config = {
  provider: "typesafe" as const,
  modelId: "jev-latest",
  model: {} as never,
};

describe("decideColdEmail", () => {
  beforeEach(() => vi.clearAllMocks());

  it("treats the middle band as uncertain, since a false cold hides real mail", async () => {
    runDecisionModelMock.mockResolvedValue({
      answers: { cold_email: { type: "boolean", probability: 0.74 } },
    });

    await expect(
      decideColdEmail({
        config,
        email: getEmail(),
        emailAccount: getEmailAccount(),
        coldEmailRule: null,
        logger: createTestLogger(),
      }),
    ).rejects.toBeInstanceOf(DecisionUncertainError);
  });

  it("decides not cold only at a confident low probability", async () => {
    runDecisionModelMock.mockResolvedValue({
      answers: { cold_email: { type: "boolean", probability: 0.05 } },
    });

    const result = await decideColdEmail({
      config,
      email: getEmail(),
      emailAccount: getEmailAccount(),
      coldEmailRule: null,
      logger: createTestLogger(),
    });

    expect(result.coldEmail).toBe(false);
  });

  it("classifies high-confidence outreach as cold", async () => {
    runDecisionModelMock.mockResolvedValue({
      answers: { cold_email: { type: "boolean", probability: 0.95 } },
    });

    const result = await decideColdEmail({
      config,
      email: getEmail(),
      emailAccount: getEmailAccount(),
      coldEmailRule: null,
      logger: createTestLogger(),
    });

    expect(result.coldEmail).toBe(true);
  });
});
