import { formatUtcDate } from "@/utils/date";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const MAX_CHAT_MEMORIES = 20;

export async function getRecentChatMemories({
  emailAccountId,
  logger,
  logContext,
}: {
  emailAccountId: string;
  logger: Logger;
  /** Free-form label for log attribution; callers go through loadAgentContext. */
  logContext: string;
}): Promise<{ content: string; date: string }[]> {
  try {
    const memories = await prisma.chatMemory.findMany({
      // Superseded memories are excluded, not labelled. Handing the model
      // both the old and new fact and trusting it to prefer the newer one is
      // the configuration that measurably fails.
      where: { emailAccountId, supersededAt: null },
      orderBy: { createdAt: "desc" },
      take: MAX_CHAT_MEMORIES,
      select: { content: true, createdAt: true },
    });

    return memories.reverse().map((memory) => ({
      content: memory.content,
      date: formatUtcDate(memory.createdAt),
    }));
  } catch (error) {
    logger.warn(`Failed to load memories for ${logContext}`, { error });
    return [];
  }
}
