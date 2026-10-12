import { z } from "zod";

// Backport of upstream inbox-zero `utils/decision-model/system-one.ts`
// (603dc322b). Upstream wraps this fetch in an AI SDK 7 decision-model
// interface; this fork is on AI SDK 6, so it is called directly. Both TypeSafe
// and OpenRouter serve the same System One protocol.

const REQUEST_TIMEOUT_MS = 15_000;

const probabilitySchema = z.number().min(0).max(1);

const systemOneResponseSchema = z.object({
  id: z.string().optional(),
  model: z.string(),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative().optional().default(0),
    cost: z.number().nonnegative().optional(),
  }),
  answers: z.record(
    z.string(),
    z.discriminatedUnion("type", [
      z.object({
        type: z.literal("choice"),
        choice: z.string(),
        confidence: probabilitySchema.optional(),
        probabilities: z.record(z.string(), probabilitySchema),
      }),
      z.object({ type: z.literal("noul"), noul: probabilitySchema }),
    ]),
  ),
});

export type DecisionQuestion =
  | {
      type: "choice";
      instructions: string | Record<string, string>;
      criteria: Record<string, string>;
    }
  | {
      type: "boolean";
      instructions: string | Record<string, string>;
      criteria: { true: string; false: string };
    };

export type DecisionAnswer =
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | { type: "boolean"; probability: number };

export type SystemOneResult = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost?: number;
  answers: Record<string, DecisionAnswer>;
};

export async function callSystemOne({
  url,
  apiKey,
  modelId,
  state,
  questions,
}: {
  url: string;
  apiKey: string;
  modelId: string;
  state: Record<string, unknown>;
  questions: Record<string, DecisionQuestion>;
}): Promise<SystemOneResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      // Drops undefined fields, which the API rejects.
      state: JSON.parse(JSON.stringify(state)),
      questions: Object.fromEntries(
        Object.entries(questions).map(([id, question]) => [
          id,
          question.type === "boolean"
            ? { ...question, type: "noul" }
            : question,
        ]),
      ),
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // The request body is email content, so it stays out of the error.
    throw new Error(`Decision request failed with status ${response.status}`);
  }

  const body = systemOneResponseSchema.parse(await response.json());

  return {
    model: body.model,
    inputTokens: body.usage.input_tokens,
    outputTokens: body.usage.output_tokens,
    cost: body.usage.cost,
    answers: Object.fromEntries(
      Object.entries(body.answers).map(([id, answer]) => [
        id,
        answer.type === "noul"
          ? { type: "boolean", probability: answer.noul }
          : {
              type: "choice",
              choice: answer.choice,
              // Providers that don't report confidence fall back to the chosen
              // option's probability, as upstream does.
              confidence:
                answer.confidence ?? answer.probabilities[answer.choice] ?? 0,
              probabilities: answer.probabilities,
            },
      ]),
    ),
  };
}
