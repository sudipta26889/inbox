import type { Prisma } from "@/generated/prisma/client";
import { env } from "@/env";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { saveAiUsage } from "@/utils/usage";
import {
  callSystemOne,
  type DecisionQuestion,
  type SystemOneResult,
} from "./system-one";

// Adapted from upstream inbox-zero `utils/decision-model/decision-model.ts`
// (063caf0a6, 603dc322b). Differences, all deliberate:
// - Shadow mode: unless a feature is listed in DECISION_MODEL_LIVE, the LLM
//   still decides and Jev's answer is only recorded for comparison.
// - Uncertain answers escalate to DECISION_ESCALATION_MODEL instead of the
//   account's own (cheaper) model.
// - No per-user opt-in column, and no upstream rule that skips users with
//   their own aiApiKey: on this deployment every user's aiApiKey is a LiteLLM
//   virtual key, so that rule would disable Jev for everyone.
// - No AI SDK 7 / trial-usage / sensitive-data hooks (not in this fork).

export type { DecisionQuestion };

export type DecisionModelConfig = {
  provider: "typesafe" | "openrouter" | "litellm";
  modelId: string;
  url: string;
  apiKey: string;
  onResult?: (result: SystemOneResult) => void;
};

/** Thrown by a decision when Jev's confidence is too low to act on. */
export class DecisionUncertainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionUncertainError";
  }
}

export function getDecisionModelConfig(): DecisionModelConfig | null {
  const value = env.DEFAULT_DECISION_MODEL?.trim();
  if (!value) return null;

  const separator = value.indexOf(":");
  const provider = value.slice(0, separator);
  const modelId = value.slice(separator + 1);
  if (separator <= 0 || !modelId) return null;

  if (provider === "typesafe") {
    const apiKey = env.TYPESAFE_API_KEY?.trim();
    return apiKey
      ? {
          provider,
          modelId,
          url: "https://api.typesafe.ai/v1/systemone",
          apiKey,
        }
      : null;
  }
  if (provider === "litellm") {
    // LiteLLM's /systemone route passes the System One protocol straight
    // through to TypeSafe, so no separate TypeSafe key is needed.
    const apiKey = env.LLM_API_KEY?.trim();
    const base = (env.LITELLM_BASE_URL || "http://localhost:4000/v1").replace(
      /\/$/,
      "",
    );
    return apiKey
      ? { provider, modelId, url: `${base}/systemone`, apiKey }
      : null;
  }
  if (provider === "openrouter") {
    const apiKey = env.OPENROUTER_API_KEY?.trim();
    return apiKey
      ? {
          provider,
          modelId,
          url: "https://openrouter.ai/api/alpha/decisions",
          apiKey,
        }
      : null;
  }
  return null;
}

export function isDecisionFeatureLive(feature: string) {
  return (env.DECISION_MODEL_LIVE ?? "")
    .split(",")
    .map((item: string) => item.trim())
    .includes(feature);
}

export async function runDecisionModel({
  config,
  emailAccount,
  state,
  questions,
  label,
}: {
  config: DecisionModelConfig;
  emailAccount: EmailAccountWithAI;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
  label: string;
}): Promise<SystemOneResult> {
  const result = await callSystemOne({
    url: config.url,
    apiKey: config.apiKey,
    modelId: config.modelId,
    state,
    questions,
  });

  config.onResult?.(result);

  await saveAiUsage({
    email: emailAccount.email,
    emailAccountId: emailAccount.id,
    provider: config.provider,
    model: config.modelId,
    usage: {
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      totalTokens: result.inputTokens + result.outputTokens,
    } as Parameters<typeof saveAiUsage>[0]["usage"],
    label,
  });

  return result;
}

/**
 * Routes one decision between Jev and the LLM.
 *
 * - No decision model configured → LLM, unchanged.
 * - Shadow (default) → LLM decides; Jev runs in parallel and both answers are
 *   recorded. Jev never affects the result or adds latency.
 * - Live → Jev decides; an uncertain answer escalates to the escalation model,
 *   any other failure falls back to the account's own model.
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
  subjectKey?: string | null;
  decide: (config: DecisionModelConfig) => Promise<T>;
  fallback: (emailAccount: EmailAccountWithAI) => Promise<T>;
  same: (jev: T, llm: T) => boolean;
}): Promise<T> {
  const config = getDecisionModelConfig();
  if (!config) return fallback(emailAccount);

  const started = Date.now();
  let answers: SystemOneResult | undefined;
  let latencyMs: number | undefined;
  const tracked: DecisionModelConfig = {
    ...config,
    onResult: (result) => {
      answers = result;
      latencyMs = Date.now() - started;
    },
  };
  const record = (run: RunOutcome) =>
    recordRun({
      emailAccountId: emailAccount.id,
      feature,
      subjectKey,
      model: answers?.model ?? config.modelId,
      answers,
      latencyMs: latencyMs ?? Date.now() - started,
      logger,
      ...run,
    });

  if (!isDecisionFeatureLive(feature)) {
    const jev = decide(tracked).then(
      (result) => ({ ok: true as const, result }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let llmResult: T;
    try {
      llmResult = await fallback(emailAccount);
    } catch (llmError) {
      // Still a decision for the LLM, so the error propagates unchanged — but
      // keep Jev's answer: these are the cases where the comparison matters most.
      jev.then((jevRun) =>
        record({
          mode: "shadow",
          outcome: "llm-error",
          jevResult: jevRun.ok ? jevRun.result : undefined,
          error: `LLM: ${getErrorMessage(llmError)}${
            jevRun.ok ? "" : ` | Jev: ${getErrorMessage(jevRun.error)}`
          }`,
        }),
      );
      throw llmError;
    }

    // ponytail: not awaited, so a slow or failing Jev call can never delay or
    // break the decision the LLM already made.
    jev.then((jevRun) =>
      record({
        mode: "shadow",
        outcome: jevRun.ok
          ? same(jevRun.result, llmResult)
            ? "agree"
            : "disagree"
          : jevRun.error instanceof DecisionUncertainError
            ? "uncertain"
            : "error",
        jevResult: jevRun.ok ? jevRun.result : undefined,
        llmResult,
        error: jevRun.ok ? undefined : getErrorMessage(jevRun.error),
      }),
    );
    return llmResult;
  }

  try {
    const result = await decide(tracked);
    record({ mode: "live", outcome: "decided", jevResult: result });
    return result;
  } catch (error) {
    if (error instanceof DecisionUncertainError) {
      const result = await fallback(getEscalationAccount(emailAccount));
      record({
        mode: "live",
        outcome: "escalated",
        llmResult: result,
        error: error.message,
      });
      return result;
    }

    logger.warn("Decision model failed, falling back to LLM", {
      error: getErrorMessage(error),
      feature,
    });
    const result = await fallback(emailAccount);
    record({
      mode: "live",
      outcome: "fallback",
      llmResult: result,
      error: getErrorMessage(error),
    });
    return result;
  }
}

/**
 * The same account, but with its model swapped for DECISION_ESCALATION_MODEL
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
  RunRecord,
  "mode" | "outcome" | "jevResult" | "llmResult" | "error"
>;

type RunRecord = {
  emailAccountId: string;
  feature: string;
  subjectKey?: string | null;
  mode: "shadow" | "live";
  outcome: string;
  model?: string;
  answers?: SystemOneResult;
  latencyMs?: number;
  jevResult?: unknown;
  llmResult?: unknown;
  error?: string;
  logger: Logger;
};

async function recordRun({ logger, ...run }: RunRecord) {
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
        answers: toJson(run.answers?.answers),
        latencyMs: run.latencyMs,
        error: run.error,
      },
    });
  } catch (error) {
    logger.warn("Failed to record decision model run", {
      error: getErrorMessage(error),
      feature: run.feature,
    });
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue);
}

// Errors can carry request input, which here is email content.
function getErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Non-Error rejection";
}
