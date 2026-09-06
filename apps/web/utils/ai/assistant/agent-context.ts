import "server-only";
import { getInboxStatsForChatContext } from "@/utils/ai/assistant/get-inbox-stats-for-chat-context";
import { getRecentChatMemories } from "@/utils/ai/assistant/get-recent-chat-memories";
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
export async function loadAgentContext({
  emailAccountId,
  provider,
  surface,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  /** Free-form label used only for log attribution. */
  surface: string;
  logger: Logger;
}) {
  const [inboxStats, memories] = await Promise.all([
    getInboxStatsForChatContext({ emailAccountId, provider, logger }),
    getRecentChatMemories({ emailAccountId, logger, logContext: surface }),
  ]);

  return { inboxStats, memories };
}
