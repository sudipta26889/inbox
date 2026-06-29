// ponytail: USD per million tokens. Update when models or contracts change;
// stored token counts on TaskpilotDecision rows let us re-price on read.
export const MODEL_PRICES: Record<
  string,
  { inputPerMillion: number; outputPerMillion: number }
> = {
  "kimi-k2.6": { inputPerMillion: 2.5, outputPerMillion: 10.0 },
  "mistral-small-24b": { inputPerMillion: 0.2, outputPerMillion: 0.6 },
  "gpt-4o-mini": { inputPerMillion: 0.15, outputPerMillion: 0.6 },
};

export function computeCost(input: {
  model: string;
  inputTokens: number;
  outputTokens: number;
}): number {
  const price = MODEL_PRICES[input.model];
  if (!price) return 0;
  const dollars =
    (input.inputTokens * price.inputPerMillion +
      input.outputTokens * price.outputPerMillion) /
    1_000_000;
  return Math.round(dollars * 10_000) / 10_000;
}
