import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger, getEmailAccount } from "@/__tests__/helpers";

const envMock = vi.hoisted(() => ({
  DEFAULT_DECISION_MODEL: undefined as string | undefined,
  DEFAULT_DECISION_MODEL_ENABLED: false,
  TYPESAFE_API_KEY: undefined as string | undefined,
  OPENROUTER_API_KEY: undefined as string | undefined,
  LLM_API_KEY: undefined as string | undefined,
  DECISION_MODEL_LIVE: undefined as string | undefined,
  DECISION_ESCALATION_MODEL: undefined as string | undefined,
  DECISION_MIN_CONFIDENCE: undefined as number | undefined,
  DECISION_LIVE_AUDIT: undefined as "true" | "false" | undefined,
}));

vi.mock("@/env", () => ({ env: envMock }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
}));
vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

import { Experimental_DecisionMockModelV4 } from "ai/test";
import prisma from "@/utils/__mocks__/prisma";
import { saveAiUsage } from "@/utils/usage";
import {
  DecisionUncertainError,
  getDecisionModelConfig,
  runDecisionModel,
  runDecisionModelOrFallback,
} from "./decision-model";

const logger = createTestLogger();
const doDecide = vi.fn();
const config = {
  provider: "typesafe" as const,
  modelId: "test-model",
  model: new Experimental_DecisionMockModelV4({ doDecide }),
};
const appliesQuestion = {
  applies: { type: "boolean", instructions: "Does it apply?" },
} as const;

describe("getDecisionModelConfig", () => {
  const deploymentConfig = { provider: "typesafe", modelId: "jev-latest" };

  beforeEach(() => {
    vi.clearAllMocks();
    envMock.DEFAULT_DECISION_MODEL = "typesafe:jev-latest";
    envMock.DEFAULT_DECISION_MODEL_ENABLED = false;
    envMock.TYPESAFE_API_KEY = "key";
    envMock.OPENROUTER_API_KEY = undefined;
    envMock.LLM_API_KEY = undefined;
  });

  function mockUserSetting(
    decisionModelEnabled: boolean | null,
    aiApiKey: string | null = null,
  ) {
    prisma.user.findUnique.mockResolvedValue({
      decisionModelEnabled,
      aiApiKey,
    } as never);
  }

  it("returns null without a database lookup when no decision model is configured", async () => {
    envMock.DEFAULT_DECISION_MODEL = undefined;

    expect(await getDecisionModelConfig(getEmailAccount())).toBeNull();
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it("returns null when the TypeSafe key is missing, even with LLM_API_KEY", async () => {
    envMock.TYPESAFE_API_KEY = undefined;
    envMock.LLM_API_KEY = "shared-key";
    mockUserSetting(true);

    expect(await getDecisionModelConfig(getEmailAccount())).toBeNull();
  });

  it("resolves OpenRouter decision models with the OpenRouter key", async () => {
    envMock.DEFAULT_DECISION_MODEL = "openrouter:cloudflare/clef";
    envMock.OPENROUTER_API_KEY = "openrouter-key";
    mockUserSetting(true);

    const config = await getDecisionModelConfig(getEmailAccount());

    expect(config).toMatchObject({
      provider: "openrouter",
      modelId: "cloudflare/clef",
      model: { provider: "openrouter", modelId: "cloudflare/clef" },
    });
  });

  it("falls back to LLM_API_KEY when the provider key is unset or blank", async () => {
    envMock.DEFAULT_DECISION_MODEL = "openrouter:cloudflare/clef";
    envMock.OPENROUTER_API_KEY = "  ";
    mockUserSetting(true);
    expect(await getDecisionModelConfig(getEmailAccount())).toBeNull();

    envMock.LLM_API_KEY = "shared-key";

    expect(await getDecisionModelConfig(getEmailAccount())).toMatchObject({
      provider: "openrouter",
      modelId: "cloudflare/clef",
    });
  });

  it("is opt-in when the deployment default is off", async () => {
    mockUserSetting(null);
    expect(await getDecisionModelConfig(getEmailAccount())).toBeNull();

    mockUserSetting(true);
    expect(await getDecisionModelConfig(getEmailAccount())).toMatchObject(
      deploymentConfig,
    );
  });

  it("is on unless the user opts out when the deployment default is on", async () => {
    envMock.DEFAULT_DECISION_MODEL_ENABLED = true;

    mockUserSetting(null);
    expect(await getDecisionModelConfig(getEmailAccount())).toMatchObject(
      deploymentConfig,
    );

    mockUserSetting(false);
    expect(await getDecisionModelConfig(getEmailAccount())).toBeNull();
  });

  it("enrolls users with their own (LiteLLM virtual) AI key through the deployment default", async () => {
    envMock.DEFAULT_DECISION_MODEL_ENABLED = true;

    mockUserSetting(null, "user-key");
    expect(await getDecisionModelConfig(getEmailAccount())).toMatchObject(
      deploymentConfig,
    );

    mockUserSetting(true, "user-key");
    expect(await getDecisionModelConfig(getEmailAccount())).toMatchObject(
      deploymentConfig,
    );
  });
});

describe("runDecisionModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call the provider when the sensitive data policy blocks the request", async () => {
    await expect(
      runDecisionModel({
        config,
        emailAccount: { ...getEmailAccount(), sensitiveDataPolicy: "BLOCK" },
        state: { content: `client_secret=${"c".repeat(24)}` },
        questions: appliesQuestion,
        label: "test",
        logger,
      }),
    ).rejects.toThrow("blocked by your account settings");
    expect(doDecide).not.toHaveBeenCalled();
  });

  it("sends redacted state to the provider under a REDACT policy", async () => {
    const secret = "c".repeat(24);
    doDecide.mockResolvedValue(
      decisionResult({ applies: { type: "boolean", probability: 0.5 } }),
    );

    await runDecisionModel({
      config,
      emailAccount: { ...getEmailAccount(), sensitiveDataPolicy: "REDACT" },
      state: { content: `client_secret=${secret}` },
      questions: appliesQuestion,
      label: "test",
      logger,
    });

    const sent = JSON.stringify(doDecide.mock.calls[0]?.[0].state);
    expect(sent).not.toContain(secret);
  });

  it("sends state with undefined fields, such as a missing header", async () => {
    doDecide.mockResolvedValue(
      decisionResult({ applies: { type: "boolean", probability: 0.5 } }),
    );

    await runDecisionModel({
      config,
      emailAccount: getEmailAccount(),
      state: { email: { subject: "Hi", to: undefined } },
      questions: appliesQuestion,
      label: "test",
      logger,
    });

    expect(doDecide.mock.calls[0]?.[0].state).toStrictEqual([
      { type: "json", value: { email: { subject: "Hi" } } },
    ]);
  });

  it("records usage and provider-reported cost for the configured model", async () => {
    doDecide.mockResolvedValue({
      ...decisionResult({ applies: { type: "boolean", probability: 0.5 } }),
      usage: { inputTokens: 1200, outputTokens: 12 },
      providerMetadata: { typesafe: { usage: { cost: 0.0003 } } },
    });

    await runDecisionModel({
      config,
      emailAccount: getEmailAccount(),
      state: {},
      questions: appliesQuestion,
      label: "test",
      logger,
    });

    expect(saveAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "typesafe",
        model: "test-model",
        label: "test",
        providerReportedCost: 0.0003,
        usage: expect.objectContaining({
          inputTokens: 1200,
          outputTokens: 12,
          totalTokens: 1212,
        }),
      }),
    );
  });

  it("uses provider-reported choice confidence, else the chosen probability", async () => {
    doDecide.mockResolvedValue({
      ...decisionResult({
        reported: {
          type: "choice",
          choice: "a",
          probabilities: { a: 0.9, b: 0.1 },
        },
        derived: {
          type: "choice",
          choice: "b",
          probabilities: { a: 0.2, b: 0.8 },
        },
      }),
      providerMetadata: { typesafe: { confidence: { reported: 0.6 } } },
    });

    const choice = {
      type: "choice",
      instructions: "Pick one",
      criteria: { a: "A", b: "B" },
    } as const;
    const response = await runDecisionModel({
      config,
      emailAccount: getEmailAccount(),
      state: {},
      questions: { reported: choice, derived: choice },
      label: "test",
      logger,
    });

    expect(response.answers.reported).toMatchObject({ confidence: 0.6 });
    expect(response.answers.derived).toMatchObject({ confidence: 0.8 });
  });
});

describe("runDecisionModelOrFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.DEFAULT_DECISION_MODEL = "typesafe:jev-latest";
    envMock.DEFAULT_DECISION_MODEL_ENABLED = true;
    envMock.TYPESAFE_API_KEY = "key";
    envMock.DECISION_MODEL_LIVE = undefined;
    envMock.DECISION_ESCALATION_MODEL = undefined;
    envMock.DECISION_LIVE_AUDIT = undefined;
    prisma.user.findUnique.mockResolvedValue({
      decisionModelEnabled: null,
      aiApiKey: "litellm-key",
    } as never);
    prisma.decisionModelRun.create.mockResolvedValue({} as never);
  });

  function route(
    decide: () => Promise<string>,
    fallback: (account: ReturnType<typeof getEmailAccount>) => Promise<string>,
    feature = "thread-status",
  ) {
    return runDecisionModelOrFallback({
      emailAccount: getEmailAccount(),
      logger,
      feature,
      subjectKey: "thread-1",
      decide,
      fallback,
      same: (a, b) => a === b,
    });
  }

  function recorded() {
    return prisma.decisionModelRun.create.mock.calls.map(
      ([args]) => args.data,
    );
  }

  it("keeps the original path and records nothing when the user opted out", async () => {
    prisma.user.findUnique.mockResolvedValue({
      decisionModelEnabled: false,
      aiApiKey: null,
    } as never);
    const decide = vi.fn();

    expect(await route(decide, async () => "llm")).toBe("llm");
    expect(decide).not.toHaveBeenCalled();
    expect(prisma.decisionModelRun.create).not.toHaveBeenCalled();
  });

  it("falls back when decision-model configuration lookup fails", async () => {
    prisma.user.findUnique.mockRejectedValue(new Error("database unavailable"));
    const decide = vi.fn();

    expect(await route(decide, async () => "llm")).toBe("llm");
    expect(decide).not.toHaveBeenCalled();
  });

  it("shadow: the LLM decides and both answers are recorded", async () => {
    const result = await route(
      async () => "TO_REPLY",
      async () => "FYI",
    );

    expect(result).toBe("FYI");
    await vi.waitFor(() =>
      expect(recorded()).toEqual([
        expect.objectContaining({
          feature: "thread-status",
          subjectKey: "thread-1",
          mode: "shadow",
          outcome: "disagree",
          jevResult: "TO_REPLY",
          llmResult: "FYI",
        }),
      ]),
    );
  });

  it("shadow: an uncertain decision model is recorded as uncertain", async () => {
    await route(
      async () => {
        throw new DecisionUncertainError("0.90 is below 0.95");
      },
      async () => "FYI",
    );

    await vi.waitFor(() =>
      expect(recorded()).toEqual([
        expect.objectContaining({ mode: "shadow", outcome: "uncertain" }),
      ]),
    );
  });

  it("shadow: keeps the record and rethrows when the LLM fails", async () => {
    await expect(
      route(
        async () => "TO_REPLY",
        async () => {
          throw new Error("llm down");
        },
      ),
    ).rejects.toThrow("llm down");

    await vi.waitFor(() =>
      expect(recorded()).toEqual([
        expect.objectContaining({
          mode: "shadow",
          outcome: "llm-error",
          jevResult: "TO_REPLY",
        }),
      ]),
    );
  });

  it("live: the decision model decides and the LLM audit is recorded", async () => {
    envMock.DECISION_MODEL_LIVE = "cold-email, thread-status";

    const result = await route(
      async () => "TO_REPLY",
      async () => "TO_REPLY",
    );

    expect(result).toBe("TO_REPLY");
    await vi.waitFor(() =>
      expect(recorded()).toEqual([
        expect.objectContaining({ mode: "live", outcome: "decided-agree" }),
      ]),
    );
  });

  it("live: no audit call when DECISION_LIVE_AUDIT=false", async () => {
    envMock.DECISION_MODEL_LIVE = "thread-status";
    envMock.DECISION_LIVE_AUDIT = "false";
    const fallback = vi.fn();

    expect(await route(async () => "TO_REPLY", fallback)).toBe("TO_REPLY");
    expect(fallback).not.toHaveBeenCalled();
    expect(recorded()).toEqual([
      expect.objectContaining({ mode: "live", outcome: "decided" }),
    ]);
  });

  it("live: an uncertain answer escalates to DECISION_ESCALATION_MODEL", async () => {
    envMock.DECISION_MODEL_LIVE = "thread-status";
    envMock.DECISION_ESCALATION_MODEL = "litellm:deepseek-v4-flash";
    const fallback = vi.fn(async () => "AWAITING_REPLY");

    const result = await route(async () => {
      throw new DecisionUncertainError("unsure");
    }, fallback);

    expect(result).toBe("AWAITING_REPLY");
    expect(fallback.mock.calls[0][0].user).toMatchObject({
      aiProvider: "litellm",
      aiModel: "deepseek-v4-flash",
    });
    expect(recorded()).toEqual([
      expect.objectContaining({ mode: "live", outcome: "escalated" }),
    ]);
  });

  it("live: any other failure falls back to the account's own model", async () => {
    envMock.DECISION_MODEL_LIVE = "thread-status";
    envMock.DECISION_ESCALATION_MODEL = "litellm:deepseek-v4-flash";
    const account = getEmailAccount();
    const fallback = vi.fn(async () => "llm");

    await route(async () => {
      throw new Error("provider down");
    }, fallback);

    expect(fallback.mock.calls[0][0].user.aiModel).toBe(account.user.aiModel);
    expect(recorded()).toEqual([
      expect.objectContaining({ mode: "live", outcome: "fallback" }),
    ]);
  });

  it("a feature not listed in DECISION_MODEL_LIVE stays in shadow", async () => {
    envMock.DECISION_MODEL_LIVE = "thread-status";

    const result = await route(
      async () => "decided",
      async () => "llm",
      "recurring-pattern",
    );

    expect(result).toBe("llm");
  });
});

function decisionResult(answers: Record<string, unknown>) {
  return { answers, warnings: [] };
}
