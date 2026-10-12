import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { getEmailAccount } from "@/__tests__/helpers";
import { createScopedLogger } from "@/utils/logger";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import {
  DecisionUncertainError,
  getDecisionModelConfig,
  runDecisionModelOrFallback,
} from "./decision-model";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}));
vi.mock("@/env", () => ({ env: mockEnv }));

const logger = createScopedLogger("decision-model-test");

const account = getEmailAccount();
account.user = {
  aiProvider: "ollama-cloud",
  aiModel: "nemotron-3-nano:30b",
  aiApiKey: "sk-litellm-key",
};

describe("runDecisionModelOrFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    for (const key of Object.keys(mockEnv)) mockEnv[key] = undefined;
    mockEnv.DEFAULT_DECISION_MODEL = "typesafe:jev-1.13.0";
    mockEnv.TYPESAFE_API_KEY = "typesafe-key";
    mockEnv.DECISION_ESCALATION_MODEL = "litellm:deepseek-v4-flash";
    prisma.decisionModelRun.create.mockResolvedValue({} as never);
  });

  it("uses the LLM unchanged when no decision model is configured", async () => {
    mockEnv.DEFAULT_DECISION_MODEL = undefined;
    const decide = vi.fn();
    const fallback = vi.fn(async () => "llm");

    const result = await route({ decide, fallback });

    expect(result).toBe("llm");
    expect(decide).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledWith(account);
    expect(prisma.decisionModelRun.create).not.toHaveBeenCalled();
  });

  describe("shadow mode (feature not live)", () => {
    it("returns the LLM's answer and records agreement", async () => {
      const result = await route({
        decide: async () => "same",
        fallback: async () => "same",
      });
      await flushRecording();

      expect(result).toBe("same");
      expect(recorded()).toMatchObject({ mode: "shadow", outcome: "agree" });
    });

    it("records disagreement without changing the decision", async () => {
      const result = await route({
        decide: async () => "jev",
        fallback: async () => "llm",
      });
      await flushRecording();

      expect(result).toBe("llm");
      expect(recorded()).toMatchObject({
        outcome: "disagree",
        jevResult: "jev",
        llmResult: "llm",
      });
    });

    it("records an uncertain Jev answer as would-escalate", async () => {
      await route({
        decide: async () => {
          throw new DecisionUncertainError("low confidence");
        },
        fallback: async () => "llm",
      });
      await flushRecording();

      expect(recorded()).toMatchObject({ outcome: "uncertain" });
    });

    it("records Jev's answer when the LLM fails, and still surfaces the LLM error", async () => {
      await expect(
        route({
          decide: async () => "jev",
          fallback: async () => {
            throw new Error("No deployments available");
          },
        }),
      ).rejects.toThrow("No deployments available");
      await flushRecording();

      expect(recorded()).toMatchObject({
        mode: "shadow",
        outcome: "llm-error",
        jevResult: "jev",
        error: "LLM: No deployments available",
      });
    });

    it("never lets a Jev failure break the decision", async () => {
      const result = await route({
        decide: async () => {
          throw new Error("decision API down");
        },
        fallback: async () => "llm",
      });
      await flushRecording();

      expect(result).toBe("llm");
      expect(recorded()).toMatchObject({
        outcome: "error",
        error: "decision API down",
      });
    });
  });

  describe("live mode", () => {
    beforeEach(() => {
      mockEnv.DECISION_MODEL_LIVE = "cold-email, test-feature";
    });

    it("uses Jev's answer without calling the LLM", async () => {
      const fallback = vi.fn(async () => "llm");

      const result = await route({ decide: async () => "jev", fallback });

      expect(result).toBe("jev");
      expect(fallback).not.toHaveBeenCalled();
    });

    it("escalates an uncertain answer to the escalation model, keeping the stored key", async () => {
      const fallback = vi.fn(async (_account: EmailAccountWithAI) => "llm");

      const result = await route({
        decide: async () => {
          throw new DecisionUncertainError("low confidence");
        },
        fallback,
      });

      expect(result).toBe("llm");
      expect(fallback.mock.calls[0][0].user).toEqual({
        aiProvider: "litellm",
        aiModel: "deepseek-v4-flash",
        aiApiKey: "sk-litellm-key",
      });
    });

    it("falls back to the account's own model when Jev errors", async () => {
      const fallback = vi.fn(async (_account: EmailAccountWithAI) => "llm");

      await route({
        decide: async () => {
          throw new Error("timeout");
        },
        fallback,
      });

      expect(fallback).toHaveBeenCalledWith(account);
    });
  });
});

describe("getDecisionModelConfig", () => {
  beforeEach(() => {
    for (const key of Object.keys(mockEnv)) mockEnv[key] = undefined;
  });

  it("resolves TypeSafe direct", () => {
    mockEnv.DEFAULT_DECISION_MODEL = "typesafe:jev-1.13.0";
    mockEnv.TYPESAFE_API_KEY = "k";

    expect(getDecisionModelConfig()).toMatchObject({
      provider: "typesafe",
      modelId: "jev-1.13.0",
      url: "https://api.typesafe.ai/v1/systemone",
    });
  });

  it("resolves OpenRouter, keeping the slash in the model id", () => {
    mockEnv.DEFAULT_DECISION_MODEL = "openrouter:typesafe/jev-1.13";
    mockEnv.OPENROUTER_API_KEY = "k";

    expect(getDecisionModelConfig()).toMatchObject({
      provider: "openrouter",
      modelId: "typesafe/jev-1.13",
    });
  });

  it("resolves LiteLLM's System One pass-through with the gateway key", () => {
    mockEnv.DEFAULT_DECISION_MODEL = "litellm:typesafe/jev-latest";
    mockEnv.LLM_API_KEY = "sk-gateway";
    mockEnv.LITELLM_BASE_URL = "http://nuc.lan:4000/v1/";

    expect(getDecisionModelConfig()).toMatchObject({
      provider: "litellm",
      modelId: "typesafe/jev-latest",
      url: "http://nuc.lan:4000/v1/systemone",
      apiKey: "sk-gateway",
    });
  });

  it("is off when the provider key is missing", () => {
    mockEnv.DEFAULT_DECISION_MODEL = "typesafe:jev-1.13.0";

    expect(getDecisionModelConfig()).toBeNull();
  });
});

function route({
  decide,
  fallback,
}: {
  decide: () => Promise<string>;
  fallback: (account: EmailAccountWithAI) => Promise<string>;
}) {
  return runDecisionModelOrFallback({
    emailAccount: account,
    logger,
    feature: mockEnv.DECISION_MODEL_LIVE ? "test-feature" : "shadow-feature",
    decide,
    fallback,
    same: (a, b) => a === b,
  });
}

// Shadow recording is deliberately not awaited by the router.
async function flushRecording() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function recorded() {
  return prisma.decisionModelRun.create.mock.calls[0]?.[0].data;
}
