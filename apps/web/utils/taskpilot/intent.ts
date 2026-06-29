import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("taskpilot-intent");

// ponytail: minimal intent surface. Extend when you actually want
// IN_PROGRESS / ESCALATION state moves.
export type EmailIntent = "RESOLVED" | "OTHER";

// ponytail: non-reasoning model. Reasoning models (kimi-k2.6, gpt-oss-*, qwen3)
// burn through max_tokens on internal thinking before emitting output.
const INTENT_MODEL = "mistral-small-24b";
const SYSTEM_PROMPT =
  "Output exactly one of: RESOLVED or OTHER. Nothing else. " +
  "RESOLVED means the email confirms a ticket/complaint/issue has been fixed " +
  "or closed. OTHER means anything else (acknowledgement, status update, " +
  "escalation, new info).";

/**
 * Classifies whether a new email about an existing task signals resolution.
 * Returns "OTHER" on any error — never block the post-rule pipeline.
 */
export async function classifyEmailIntent(input: {
  subject: string;
  from: string;
  snippet: string;
  bodyText?: string;
}): Promise<EmailIntent> {
  const baseUrl =
    env.OPENAI_COMPATIBLE_BASE_URL ?? env.LITELLM_BASE_URL ?? null;
  if (!baseUrl) return "OTHER";

  const prompt = [
    `Subject: ${input.subject}`,
    `From: ${input.from}`,
    `Body: ${(input.bodyText ?? input.snippet).slice(0, 2000)}`,
  ].join("\n");

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(env.LLM_API_KEY
          ? { Authorization: `Bearer ${env.LLM_API_KEY}` }
          : {}),
      },
      body: JSON.stringify({
        model: INTENT_MODEL,
        max_tokens: 8,
        temperature: 0,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
    });
    if (!res.ok) {
      logger.warn("intent classifier non-ok", { status: res.status });
      return "OTHER";
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const raw = body.choices?.[0]?.message?.content?.trim().toUpperCase() ?? "";
    return raw.startsWith("RESOLVED") ? "RESOLVED" : "OTHER";
  } catch (err) {
    logger.warn("classifyEmailIntent failed; defaulting OTHER", { err });
    return "OTHER";
  }
}
