import "server-only";
import { getInboxStatsForChatContext } from "@/utils/ai/assistant/get-inbox-stats-for-chat-context";
import { getRecentChatMemories } from "@/utils/ai/assistant/get-recent-chat-memories";
import { recallMemoriesOrNone } from "@/utils/longmemory/client";
import type { Logger } from "@/utils/logger";

/**
 * The grounding every agent turn needs: durable memories plus current inbox
 * counts.
 *
 * Five call sites were each doing the same Promise.all of the same two loaders
 * — the web chat route, the Slack slash command, the messaging bot, the
 * scheduled check-in, and now the A2A answer path. Duplicated grounding drifts,
 * and the copy that drifts is the one that quietly stops loading memory. One
 * function means a new surface gets the same context by construction rather
 * than by whoever remembers to copy both halves.
 */

export type AgentMemory = { content: string; date?: string };

export async function loadAgentContext({
  emailAccountId,
  provider,
  surface,
  query,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  /** Free-form label used only for log attribution. */
  surface: string;
  /**
   * What the user actually said this turn. Given one, the relevant long-term
   * memories are injected alongside the recent ones — the agent should not have
   * to guess that a lookup tool is worth spending a step on to find out
   * something it was told last week.
   */
  query?: string;
  logger: Logger;
}): Promise<{
  inboxStats: Awaited<ReturnType<typeof getInboxStatsForChatContext>>;
  memories: AgentMemory[];
}> {
  const [inboxStats, recent, recalled] = await Promise.all([
    getInboxStatsForChatContext({ emailAccountId, provider, logger }),
    getRecentChatMemories({ emailAccountId, logger, logContext: surface }),
    query
      ? recallMemoriesOrNone({ emailAccountId, query, logger })
      : Promise.resolve([]),
  ]);

  // Recent memories last: they carry dates and are the ones the agent quotes
  // when asked "when did I tell you that", so they read better closest to the
  // question. Dedupe because a memory saved through the chat tool lives in both
  // stores by design.
  const seen = new Set<string>();
  const memories: AgentMemory[] = [];

  for (const memory of [
    ...recalled.map((m): AgentMemory => ({ content: m.content })),
    ...recent,
  ]) {
    const key = memory.content.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    memories.push(memory);
  }

  return { inboxStats, memories };
}

/**
 * The recall query for a turn, taken from what the user just said.
 *
 * Truncated because this is an embedding lookup, not the prompt — a pasted
 * email thread as the query buys nothing and costs a token budget.
 */
export function memoryQueryFromParts(
  parts: { type?: string; text?: unknown }[] | undefined,
): string | undefined {
  const text = (parts ?? [])
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join(" ")
    .trim();

  return text ? text.slice(0, 500) : undefined;
}
