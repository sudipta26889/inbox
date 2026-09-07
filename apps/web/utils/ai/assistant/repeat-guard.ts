import "server-only";
import type { Tool } from "ai";
import type { Logger } from "@/utils/logger";

/**
 * Stop an agent re-running a call it has already made.
 *
 * Observed in production: answering one A2A question, the agent issued seven
 * consecutive identical `search_inbox` calls, spent its whole step budget, and
 * returned nothing. Models repeat a call when the result did not resolve their
 * uncertainty — an empty result and a broken tool look the same from the
 * inside, and "nothing happened" reads as "try again".
 *
 * The real fixes are upstream: tool results now state their terminal condition,
 * and the final step has its tools removed so the model must write prose. This
 * is the backstop for when those are not enough, and it makes the failure
 * countable rather than invisible.
 *
 * The ledger is loop-local on purpose. Kept in message history it would be
 * summarised away by compaction mid-run, and the loop would start over.
 */

/** Identical calls run twice; the third is refused. A retry can be honest. */
const MAX_IDENTICAL_CALLS = 2;

export function withRepeatGuard<T extends Record<string, Tool>>(
  tools: T,
  logger: Logger,
): T {
  const seen = new Map<string, number>();

  const guarded = Object.entries(tools).map(([name, tool]) => {
    const execute = tool.execute;

    if (typeof execute !== "function") return [name, tool] as const;

    return [
      name,
      {
        ...tool,
        execute: async (input: unknown, options: unknown) => {
          const key = `${name}:${stableStringify(input)}`;
          const count = (seen.get(key) ?? 0) + 1;
          seen.set(key, count);

          if (count > MAX_IDENTICAL_CALLS) {
            logger.warn("Refused a repeated tool call", { tool: name, count });

            return {
              repeated: true,
              guidance: `You have already called ${name} with these exact arguments ${count - 1} times and the answer will not change. Do not call it again. Use a different query, or answer from what you already have and say what you could not determine.`,
            };
          }

          // biome-ignore lint/suspicious/noExplicitAny: forwarding the SDK's own call shape
          return (execute as any)(input, options);
        },
      },
    ] as const;
  });

  return Object.fromEntries(guarded) as T;
}

/** Key order varies between model turns; the call is still the same call. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(",")}}`;
}
