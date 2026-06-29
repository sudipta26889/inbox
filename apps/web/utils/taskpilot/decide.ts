import { callDecider } from "@/utils/taskpilot/llm";
import {
  buildPass1Prompt,
  buildPass2Prompt,
  type Pass1PromptInput,
  type Pass2PromptInput,
} from "@/utils/taskpilot/prompts";
import {
  Pass1Schema,
  Pass2Schema,
  type Pass1Decision,
  type Pass2Updates,
} from "@/utils/taskpilot/schemas";

export interface Pass1Input extends Pass1PromptInput {
  effort: "low" | "medium" | "high";
  maxTokens: number;
  model: string;
  timeoutMs: number;
}

export interface Pass2Input extends Pass2PromptInput {
  effort: "low" | "medium" | "high";
  maxTokens: number;
  model: string;
  timeoutMs: number;
}

export type Pass1Outcome =
  | {
      ok: true;
      decision: Pass1Decision;
      model: string;
      effort: string;
      durationMs: number;
      usage: { input: number; output: number } | null;
    }
  | {
      ok: false;
      errorMsg: string;
      model: string;
      effort: string;
      durationMs: number;
      usage: { input: number; output: number } | null;
    };

export type Pass2Outcome =
  | {
      ok: true;
      updates: Pass2Updates;
      model: string;
      effort: string;
      durationMs: number;
      usage: { input: number; output: number } | null;
    }
  | {
      ok: false;
      errorMsg: string;
      model: string;
      effort: string;
      durationMs: number;
      usage: { input: number; output: number } | null;
    };

export async function decidePass1(input: Pass1Input): Promise<Pass1Outcome> {
  const { system, user } = buildPass1Prompt(input);
  const r = await callDecider({
    model: input.model,
    effort: input.effort,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    system,
    user,
    schema: Pass1Schema,
  });
  if (!r.parsed) {
    return {
      ok: false,
      errorMsg: r.errorMsg ?? "unknown",
      model: input.model,
      effort: input.effort,
      durationMs: r.durationMs,
      usage: r.usage,
    };
  }
  return {
    ok: true,
    decision: r.parsed,
    model: input.model,
    effort: input.effort,
    durationMs: r.durationMs,
    usage: r.usage,
  };
}

export async function decidePass2(input: Pass2Input): Promise<Pass2Outcome> {
  const { system, user } = buildPass2Prompt(input);
  const r = await callDecider({
    model: input.model,
    effort: input.effort,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    system,
    user,
    schema: Pass2Schema,
  });
  if (!r.parsed) {
    return {
      ok: false,
      errorMsg: r.errorMsg ?? "unknown",
      model: input.model,
      effort: input.effort,
      durationMs: r.durationMs,
      usage: r.usage,
    };
  }
  return {
    ok: true,
    updates: r.parsed,
    model: input.model,
    effort: input.effort,
    durationMs: r.durationMs,
    usage: r.usage,
  };
}
