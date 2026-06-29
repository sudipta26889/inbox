import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import type { z } from "zod";

const logger = createScopedLogger("taskpilot-llm");

export interface CallDeciderInput<T> {
  effort: "low" | "medium" | "high";
  maxTokens: number;
  model: string;
  schema: z.ZodType<T>;
  system: string;
  timeoutMs: number;
  user: string;
}

export interface CallDeciderResult<T> {
  durationMs: number;
  errorMsg: string | null;
  parsed: T | null;
  raw: string;
  usage: { input: number; output: number } | null;
}

export async function callDecider<T>(
  input: CallDeciderInput<T>,
): Promise<CallDeciderResult<T>> {
  const baseUrl =
    env.OPENAI_COMPATIBLE_BASE_URL ?? env.LITELLM_BASE_URL ?? null;
  const start = Date.now();
  if (!baseUrl) {
    return {
      parsed: null,
      raw: "",
      usage: null,
      durationMs: 0,
      errorMsg: "no LITELLM/OPENAI_COMPATIBLE base url",
    };
  }

  const messages: Array<{ role: "system" | "user"; content: string }> = [
    { role: "system", content: input.system },
    { role: "user", content: input.user },
  ];

  // First attempt.
  const first = await callOnce(baseUrl, input, messages);
  if (first.kind === "http_error" || first.kind === "timeout") {
    return {
      parsed: null,
      raw: "",
      usage: first.usage,
      durationMs: Date.now() - start,
      errorMsg: first.errorMsg,
    };
  }
  const cleaned1 = stripThink(first.content);
  const parsed1 = tryParse(input.schema, cleaned1);
  if (parsed1.ok) {
    return {
      parsed: parsed1.value,
      raw: cleaned1,
      usage: first.usage,
      durationMs: Date.now() - start,
      errorMsg: null,
    };
  }
  logger.warn("pass-N schema validation failed; retrying once", {
    error: parsed1.error,
  });

  // One retry with the validation error appended.
  const retryMessages = [
    ...messages,
    {
      role: "user" as const,
      content: `Your previous response failed validation: ${parsed1.error}. Reply with valid JSON matching the schema. Do NOT include any prose, only JSON.`,
    },
  ];
  const second = await callOnce(baseUrl, input, retryMessages);
  if (second.kind === "http_error" || second.kind === "timeout") {
    return {
      parsed: null,
      raw: cleaned1,
      usage: first.usage,
      durationMs: Date.now() - start,
      errorMsg: second.errorMsg,
    };
  }
  const cleaned2 = stripThink(second.content);
  const parsed2 = tryParse(input.schema, cleaned2);
  const usageCombined = combineUsage(first.usage, second.usage);
  if (parsed2.ok) {
    return {
      parsed: parsed2.value,
      raw: cleaned2,
      usage: usageCombined,
      durationMs: Date.now() - start,
      errorMsg: null,
    };
  }
  return {
    parsed: null,
    raw: cleaned2,
    usage: usageCombined,
    durationMs: Date.now() - start,
    errorMsg: `schema invalid after retry: ${parsed2.error}`,
  };
}

// --- helpers ---

type OnceResult =
  | {
      kind: "ok";
      content: string;
      usage: { input: number; output: number } | null;
    }
  | { kind: "http_error"; errorMsg: string; usage: null }
  | { kind: "timeout"; errorMsg: string; usage: null };

async function callOnce<T>(
  baseUrl: string,
  input: CallDeciderInput<T>,
  messages: Array<{ role: "system" | "user"; content: string }>,
): Promise<OnceResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), input.timeoutMs);
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(env.LLM_API_KEY
          ? { Authorization: `Bearer ${env.LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: input.model,
        max_tokens: input.maxTokens,
        temperature: 0,
        reasoning_effort: input.effort,
        messages,
      }),
    });
    if (!res.ok) {
      return {
        kind: "http_error",
        errorMsg: `LLM HTTP ${res.status}`,
        usage: null,
      };
    }
    const body = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string };
      }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = body.choices?.[0]?.message?.content ?? "";
    const reasoning = body.choices?.[0]?.message?.reasoning_content;
    if (reasoning) {
      logger.trace("llm reasoning_content", { length: reasoning.length });
    }
    return {
      kind: "ok",
      content,
      usage: body.usage
        ? {
            input: body.usage.prompt_tokens ?? 0,
            output: body.usage.completion_tokens ?? 0,
          }
        : null,
    };
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return { kind: "timeout", errorMsg: "LLM timeout", usage: null };
    }
    return {
      kind: "http_error",
      errorMsg: `LLM fetch error: ${(err as Error).message}`,
      usage: null,
    };
  } finally {
    clearTimeout(timer);
  }
}

function stripThink(content: string): string {
  return content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

function tryParse<T>(
  schema: z.ZodType<T>,
  raw: string,
): { ok: true; value: T } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(extractJsonBlock(raw));
  } catch (e) {
    return { ok: false, error: `not valid JSON: ${(e as Error).message}` };
  }
  normalizeDiscriminators(json);
  const result = schema.safeParse(json);
  if (!result.success) {
    return { ok: false, error: result.error.message };
  }
  return { ok: true, value: result.data };
}

function extractJsonBlock(raw: string): string {
  // ponytail: strip markdown fences if model wraps JSON
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  return fence ? fence[1].trim() : raw.trim();
}

// ponytail: reasoning models occasionally emit lowercase discriminator values
// ("ignore" instead of "IGNORE"). Uppercase + trim before Zod validation so
// shape is right even when capitalization isn't. Mutates in place; safe
// because the caller has the only reference.
function normalizeDiscriminators(json: unknown): void {
  if (!json || typeof json !== "object") return;
  const obj = json as Record<string, unknown>;
  if (typeof obj.action === "string") {
    obj.action = obj.action.trim().toUpperCase();
  }
  if (typeof obj.stateConfidence === "string") {
    obj.stateConfidence = obj.stateConfidence.trim().toUpperCase();
  }
}

function combineUsage(
  a: { input: number; output: number } | null,
  b: { input: number; output: number } | null,
): { input: number; output: number } | null {
  if (!a && !b) return null;
  return {
    input: (a?.input ?? 0) + (b?.input ?? 0),
    output: (a?.output ?? 0) + (b?.output ?? 0),
  };
}
