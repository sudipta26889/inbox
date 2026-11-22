import { createGateway } from "@ai-sdk/gateway";
import { createOpenAI } from "@ai-sdk/openai";
import type {
  Experimental_DecisionModelV4,
  JSONObject,
} from "@ai-sdk/provider";
import {
  type Experimental_DecisionQuestion,
  type Experimental_DecisionResult,
  experimental_decide,
} from "ai";
import { env } from "@/env";
import type { Prisma, User } from "@/generated/prisma/client";
import { assertTrialAiUsageAllowed } from "@/utils/llms/model-usage-guard";
import { enforceSensitiveDataPolicy } from "@/utils/llms/sensitive-content";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { saveAiUsage } from "@/utils/usage";
import { createSystemOneDecisionModel } from "./system-one";

export type DecisionQuestion = Experimental_DecisionQuestion;

export type DecisionAnswer =
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: "boolean"; probability: number };

export type DecisionModelResponse = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  answers: Record<string, DecisionAnswer | undefined>;
};

type DecideResult = Experimental_DecisionResult<
  Record<string, DecisionQuestion>
>;

export type DecisionModelConfig = {
  provider: "typesafe" | "openrouter" | "aigateway" | "openai" | "litellm";
  modelId: string;
  model: Experimental_DecisionModelV4;
  /** Lets the router record the raw answers of the call it made. */
  onResult?: (response: DecisionModelResponse) => void;
};

/**
 * Thrown by a decision when the decision model's confidence is below
 * getDecisionMinConfidence(). In live mode it escalates to
 * DECISION_ESCALATION_MODEL instead of the account's own model.
 */
export class DecisionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionUncertainError";
  }
}

// local/decision rejects input over its 4,096-token window, so stay well under.
const DECISION_INPUT_MAX_TOKENS = 3500;
const CONTEXT_EXCEEDED_MESSAGE = "exceeds the 4096-token context";

export const INPUT_TOO_LONG_REASON = "input too long for the decision model";
export const UNSUPPORTED_REASON = "multi-rule selection is decided by the LLM";

/** The request would not fit the decision model's context window. */
export class DecisionInputTooLongError extends Error {
  readonly estimatedTokens: number;

  constructor(estimatedTokens: number) {
    super(INPUT_TOO_LONG_REASON);
    this.name = "DecisionInputTooLongError";
    this.estimatedTokens = estimatedTokens;
  }
}

/** Our own guard, or the gateway's 400 for a request that got past it. */
export function isDecisionInputTooLong(error: unknown) {
  if (error instanceof DecisionInputTooLongError) return true;
  if (!(error instanceof Error)) return false;
  const body = (error as { responseBody?: unknown }).responseBody;
  return (
    error.message.includes(CONTEXT_EXCEEDED_MESSAGE) ||
    (typeof body === "string" && body.includes(CONTEXT_EXCEEDED_MESSAGE))
  );
}

// An estimate, not a tokenizer: about 4 characters per token.
function estimateTokens(...parts: unknown[]) {
  return Math.ceil(
    parts.reduce<number>((sum, part) => sum + JSON.stringify(part).length, 0) /
      4,
  );
}

// 0.95: on TaskPilot's 398 labelled items every Jev answer at >= 0.95 was right.
export function getDecisionMinConfidence() {
  return env.DECISION_MIN_CONFIDENCE ?? 0.95;
}

/**
 * Features listed in DECISION_MODEL_LIVE let the decision model decide; every
 * other feature runs in shadow mode (the LLM decides, the decision model is
 * only recorded). Keys: thread-status, cold-email, categorize-sender,
 * categorize-senders-bulk, recurring-pattern, choose-rule,
 * reply-memory-selection, unsubscribe-page.
 */
export function isDecisionFeatureLive(feature: string) {
  return (env.DECISION_MODEL_LIVE ?? "")
    .split(",")
    .map((item) => item.trim())
    .includes(feature);
}

/** The optional decision model for this account, or null for the LLM path. */
export async function getDecisionModelConfig(
  emailAccount: Pick<EmailAccountWithAI, "userId">,
): Promise<DecisionModelConfig | null> {
  const config = getDeploymentDecisionModelConfig();
  if (!config) return null;

  const user = await prisma.user.findUnique({
    where: { id: emailAccount.userId },
    select: { decisionModelEnabled: true, aiApiKey: true },
  });

  return user && isDecisionModelEnabledForUser(user) ? config : null;
}

/**
 * An explicit user choice wins. Otherwise the deployment default applies.
 * Unlike upstream, a user's own AI key does not opt them out: on this
 * deployment every user's aiApiKey is a LiteLLM virtual key, so that rule would
 * switch the decision model off for everyone.
 */
export function isDecisionModelEnabledForUser(
  user: Pick<User, "decisionModelEnabled" | "aiApiKey">,
) {
  if (user.decisionModelEnabled !== null) return user.decisionModelEnabled;
  return env.DEFAULT_DECISION_MODEL_ENABLED;
}

export function isDecisionModelAvailable() {
  return !!getDeploymentDecisionModelConfig();
}

/**
 * Sends structured state to the configured decision model. Trial limits,
 * sensitive-data policy, and usage accounting match the LLM path.
 */
export async function runDecisionModel({
  config,
  emailAccount,
  state,
  questions,
  label,
  logger,
}: {
  config: DecisionModelConfig;
  emailAccount: EmailAccountWithAI;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  label: string;
  logger: Logger;
}): Promise<DecisionModelResponse> {
  await assertTrialAiUsageAllowed({
    userEmail: emailAccount.email,
    hasUserApiKey: false,
    label,
    userId: emailAccount.userId,
    emailAccountId: emailAccount.id,
  });

  const request = enforceSensitiveDataPolicy({
    options: { prompt: state, instructions: questions },
    policy: emailAccount.sensitiveDataPolicy,
    label,
    logger,
    userId: emailAccount.userId,
    emailAccountId: emailAccount.id,
  });

  const estimatedTokens = estimateTokens(request.prompt, request.instructions);
  if (estimatedTokens > DECISION_INPUT_MAX_TOKENS) {
    logger.info("Decision input too long for the decision model", {
      label,
      estimatedTokens,
      limit: DECISION_INPUT_MAX_TOKENS,
    });
    throw new DecisionInputTooLongError(estimatedTokens);
  }

  const result = await experimental_decide({
    model: config.model,
    // decide() rejects undefined fields (e.g. a missing header) that JSON
    // serialization would drop.
    state: JSON.parse(JSON.stringify(request.prompt)) as JSONObject,
    questions: request.instructions,
    // Every caller falls back to the LLM, which is the better retry.
    maxRetries: 0,
  });

  const inputTokens = result.usage.inputTokens ?? 0;
  const outputTokens = result.usage.outputTokens ?? 0;
  const providerReportedCost = getProviderCost(result, config.provider);

  await saveAiUsage({
    userId: emailAccount.userId,
    email: emailAccount.email,
    emailAccountId: emailAccount.id,
    provider: config.provider,
    model: config.modelId,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      inputTokenDetails: {
        noCacheTokens: undefined,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        textTokens: outputTokens,
        reasoningTokens: undefined,
      },
    },
    providerReportedCost,
    providerCostSource:
      providerReportedCost === undefined
        ? undefined
        : `${config.provider}_usage`,
    providerRequestIds: result.response.id ? [result.response.id] : undefined,
    label,
  });

  const response: DecisionModelResponse = {
    model: result.response.modelId,
    inputTokens,
    outputTokens,
    answers: Object.fromEntries(
      Object.entries(result.answers).map(([id, answer]) => [
        id,
        toDecisionAnswer(id, answer, result),
      ]),
    ),
  };
  config.onResult?.(response);
  return response;
}

/**
 * Routes one decision between the decision model and the LLM, and
 * records every run in DecisionModelRun.
 *
 * - No decision model for this account → LLM, unchanged, nothing recorded.
 * - Shadow (default) → the LLM decides; the decision model runs in parallel and both answers
 *   are recorded. It never affects the result or adds latency.
 * - Live (feature in DECISION_MODEL_LIVE) → the decision model decides. An uncertain answer
 *   escalates to DECISION_ESCALATION_MODEL; any other failure falls back to the
 *   account's own model. Unless DECISION_LIVE_AUDIT=false, the LLM also checks
 *   each live decision afterwards and the agreement is recorded.
 *
 * `fallback` receives the account to run the LLM with, so escalation can swap
 * its model.
 */
export async function runDecisionModelOrFallback<T>({
  emailAccount,
  logger,
  feature,
  subjectKey,
  decide,
  fallback,
  same,
}: {
  emailAccount: EmailAccountWithAI;
  logger: Logger;
  feature: string;
  /** Join key for later labels: sender address or thread id. */
  subjectKey?: string | null;
  decide: (config: DecisionModelConfig) => Promise<T>;
  fallback: (emailAccount: EmailAccountWithAI) => Promise<T>;
  same: (decisionModelResult: T, llmResult: T) => boolean;
}): Promise<T> {
  let config: DecisionModelConfig | null;
  try {
    config = await getDecisionModelConfig(emailAccount);
  } catch (error) {
    logger.warn("Decision model configuration failed, falling back to LLM", {
      error,
      feature,
    });
    return fallback(emailAccount);
  }

  if (!config) return fallback(emailAccount);

  const started = Date.now();
  let response: DecisionModelResponse | undefined;
  let latencyMs: number | undefined;
  const tracked: DecisionModelConfig = {
    ...config,
    onResult: (result) => {
      response = result;
      latencyMs = Date.now() - started;
    },
  };
  const record = (run: RunOutcome) =>
    recordDecisionModelRun({
      emailAccountId: emailAccount.id,
      feature,
      subjectKey,
      model: response?.model ?? config.modelId,
      answers: response?.answers,
      latencyMs: latencyMs ?? Date.now() - started,
      logger,
      ...run,
    });

  if (!isDecisionFeatureLive(feature)) {
    const decision = decide(tracked).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let llmResult: T;
    try {
      llmResult = await fallback(emailAccount);
    } catch (llmError) {
      // Still the LLM's decision, so the error propagates unchanged, but keep
      // the decision model's answer: these are the cases where the comparison
      // matters most.
      decision.then((run) =>
        record({
          mode: "shadow",
          outcome: "llm-error",
          jevResult: run.ok ? run.result : undefined,
          error: `LLM: ${getLoggableError(llmError).message}${
            run.ok
              ? ""
              : ` | Decision model: ${getLoggableError(run.error).message}`
          }`,
        }),
      );
      throw llmError;
    }

    // ponytail: not awaited, so a slow or failing decision-model call can never
    // delay or break the decision the LLM already made.
    decision.then((run) =>
      record({
        mode: "shadow",
        outcome: run.ok
          ? same(run.result, llmResult)
            ? "agree"
            : "disagree"
          : run.error instanceof DecisionUncertainError
            ? "uncertain"
            : isDecisionInputTooLong(run.error)
              ? "too_long"
              : "error",
        jevResult: run.ok ? run.result : undefined,
        llmResult,
        error: run.ok ? undefined : getLoggableError(run.error).message,
      }),
    );
    return llmResult;
  }

  let result: T;
  try {
    result = await decide(tracked);
  } catch (error) {
    if (error instanceof DecisionUncertainError) {
      const escalated = await fallback(getEscalationAccount(emailAccount));
      await record({
        mode: "live",
        outcome: "escalated",
        llmResult: escalated,
        error: error.message,
      });
      return escalated;
    }

    const tooLong = isDecisionInputTooLong(error);
    if (!tooLong) {
      logger.warn("Decision model failed, falling back to LLM", {
        error: getLoggableError(error),
        feature,
      });
    }
    const llmResult = await fallback(emailAccount);
    await record({
      mode: "live",
      outcome: tooLong ? "too_long" : "fallback",
      llmResult,
      error: getLoggableError(error).message,
    });
    return llmResult;
  }

  if (env.DECISION_LIVE_AUDIT === "false") {
    await record({ mode: "live", outcome: "decided", jevResult: result });
    return result;
  }

  // Audit: the LLM checks each live decision so its accuracy on this feature
  // can be proven. Not awaited, so it never delays or changes the decision.
  fallback(emailAccount).then(
    (llmResult) =>
      record({
        mode: "live",
        outcome: same(result, llmResult) ? "decided-agree" : "decided-disagree",
        jevResult: result,
        llmResult,
      }),
    (llmError: unknown) =>
      record({
        mode: "live",
        outcome: "decided",
        jevResult: result,
        error: `Audit LLM: ${getLoggableError(llmError).message}`,
      }),
  );
  return result;
}

/**
 * The same account with its model swapped for DECISION_ESCALATION_MODEL
 * ("provider:model"). The stored aiApiKey is kept, which is the LiteLLM key the
 * escalation model is reached with.
 */
export function getEscalationAccount(
  emailAccount: EmailAccountWithAI,
): EmailAccountWithAI {
  const value = env.DECISION_ESCALATION_MODEL?.trim();
  const separator = value?.indexOf(":") ?? -1;
  if (!value || separator <= 0) return emailAccount;

  return {
    ...emailAccount,
    user: {
      ...emailAccount.user,
      aiProvider: value.slice(0, separator),
      aiModel: value.slice(separator + 1),
    },
  };
}

type RunOutcome = Pick<
  DecisionModelRunRecord,
  "mode" | "outcome" | "jevResult" | "llmResult" | "error"
>;

type DecisionModelRunRecord = {
  emailAccountId: string;
  feature: string;
  subjectKey?: string | null;
  mode: "shadow" | "live";
  outcome: string;
  model?: string;
  answers?: unknown;
  latencyMs?: number;
  jevResult?: unknown;
  llmResult?: unknown;
  error?: string;
  logger: Logger;
};

/** Never throws: a lost record must not cost the decision. */
export async function recordDecisionModelRun({
  logger,
  ...run
}: DecisionModelRunRecord) {
  try {
    await prisma.decisionModelRun.create({
      data: {
        emailAccountId: run.emailAccountId,
        feature: run.feature,
        mode: run.mode,
        outcome: run.outcome,
        model: run.model,
        subjectKey: run.subjectKey ?? undefined,
        jevResult: toJson(run.jevResult),
        llmResult: toJson(run.llmResult),
        answers: toJson(run.answers),
        latencyMs: run.latencyMs,
        error: run.error,
      },
    });
  } catch (error) {
    logger.warn("Failed to record decision model run", {
      error: getLoggableError(error),
      feature: run.feature,
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

/**
 * Resolves a `provider:model` entry, or null when neither the provider key
 * nor LLM_API_KEY is set, matching how LLM entries resolve keys.
 */
export function createDecisionModelConfig(
  providerAndModel: string,
): DecisionModelConfig | null {
  const separatorIndex = providerAndModel.indexOf(":");
  const provider = providerAndModel.slice(0, separatorIndex);
  const modelId = providerAndModel.slice(separatorIndex + 1);

  switch (provider) {
    case "typesafe": {
      // Not an LLM provider, so LLM_API_KEY is never a TypeSafe key.
      const apiKey = env.TYPESAFE_API_KEY?.trim();
      if (!apiKey) return null;
      return {
        provider,
        modelId,
        model: createSystemOneDecisionModel({
          provider,
          url: "https://api.typesafe.ai/v1/systemone",
          apiKey,
          modelId,
        }),
      };
    }
    case "litellm": {
      // The gateway's /systemone route passes System One through to TypeSafe,
      // so models stay behind LiteLLM and no TypeSafe key is needed here.
      const apiKey = env.LLM_API_KEY?.trim();
      if (!apiKey) return null;
      const baseUrl = (env.LITELLM_BASE_URL || "http://localhost:4000/v1")
        .trim()
        .replace(/\/+$/, "");
      return {
        provider,
        modelId,
        model: createSystemOneDecisionModel({
          provider,
          url: `${baseUrl}/systemone`,
          apiKey,
          modelId,
        }),
      };
    }
    case "openrouter": {
      const apiKey = resolveApiKey(env.OPENROUTER_API_KEY);
      if (!apiKey) return null;
      return {
        provider,
        modelId,
        model: createSystemOneDecisionModel({
          provider,
          url: "https://openrouter.ai/api/alpha/decisions",
          apiKey,
          modelId,
        }),
      };
    }
    case "aigateway": {
      const apiKey = resolveApiKey(env.AI_GATEWAY_API_KEY);
      if (!apiKey) return null;
      return {
        provider,
        modelId,
        model: createGateway({ apiKey }).decisionModel(modelId),
      };
    }
    case "openai": {
      const apiKey = resolveApiKey(env.OPENAI_API_KEY);
      if (!apiKey) return null;
      return {
        provider,
        modelId,
        model: createOpenAI({ apiKey }).decisionModel(modelId),
      };
    }
    default:
      return null;
  }
}

function getDeploymentDecisionModelConfig() {
  return env.DEFAULT_DECISION_MODEL
    ? createDecisionModelConfig(env.DEFAULT_DECISION_MODEL)
    : null;
}

/**
 * Callers threshold on choice confidence, so a choice must come with a
 * distribution. Providers that report their own confidence (System One,
 * OpenAI) put it in provider metadata; otherwise it is the chosen option's
 * probability.
 */
function toDecisionAnswer(
  id: string,
  answer: DecideResult["answers"][string],
  result: DecideResult,
): DecisionAnswer | undefined {
  if (answer.type === "boolean") return answer;
  if (answer.type !== "choice" || !answer.probabilities) return;

  return {
    type: "choice",
    choice: answer.choice,
    confidence:
      getProviderConfidence(result, id) ?? answer.probabilities[answer.choice],
    probabilities: answer.probabilities,
  };
}

function getProviderConfidence(result: DecideResult, id: string) {
  for (const metadata of Object.values(result.providerMetadata ?? {})) {
    const confidence = metadata.confidence;
    if (isJsonObject(confidence) && typeof confidence[id] === "number") {
      return confidence[id];
    }
  }
}

function getProviderCost(
  result: DecideResult,
  provider: DecisionModelConfig["provider"],
) {
  const usage = result.providerMetadata?.[provider]?.usage;
  return isJsonObject(usage) && typeof usage.cost === "number"
    ? usage.cost
    : undefined;
}

// Blank keys count as unset so they fall back to LLM_API_KEY instead of
// failing every call.
function resolveApiKey(providerApiKey: string | undefined) {
  return providerApiKey?.trim() || env.LLM_API_KEY?.trim();
}

function isJsonObject(value: unknown): value is JSONObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// AI SDK errors can carry the request input, which here is email content.
function getLoggableError(error: unknown) {
  return error instanceof Error
    ? { name: error.name, message: error.message }
    : { name: "UnknownError", message: "Non-Error rejection" };
}
