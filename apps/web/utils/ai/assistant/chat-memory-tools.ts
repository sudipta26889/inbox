import { type InferUITool, tool } from "ai";
import { z } from "zod";
import prisma from "@/utils/prisma";
import { formatUtcDate } from "@/utils/date";
import type { Logger } from "@/utils/logger";
import { ingestMemory, recallMemories } from "@/utils/longmemory/client";
import { saveMemory } from "@/utils/ai/assistant/save-memory";

export const searchMemoriesTool = ({
  email,
  emailAccountId,
  logger,
}: {
  email: string;
  emailAccountId: string;
  logger: Logger;
}) =>
  tool({
    description:
      "Search memories from previous conversations. Use this when you need context about past interactions, user preferences discussed before, or decisions made in earlier conversations.",
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe(
          "Search query to find relevant memories (e.g., 'newsletter rules', 'meeting preferences')",
        ),
    }),
    execute: async ({ query }) => {
      logger.trace("Tool call: search_memories", { email });
      try {
        // Semantic recall plus the literal scan. The scan alone missed any
        // memory that did not contain the query as a substring, which is most
        // of them; long memory alone would miss anything saved before it was
        // wired up, since ChatMemory rows were never backfilled.
        const [recalled, local] = await Promise.all([
          // Null, not [], when long memory is unreachable. Reporting "no
          // matching memories" for a store we failed to read is the lie this
          // whole path exists to stop telling.
          recallMemories({ emailAccountId, query }).catch((error) => {
            logger.warn("Long memory recall failed in search_memories", {
              error,
            });
            return null;
          }),
          prisma.chatMemory.findMany({
            where: {
              emailAccountId,
              content: { contains: query, mode: "insensitive" },
              supersededAt: null,
            },
            orderBy: { createdAt: "desc" },
            take: 10,
            select: { content: true, createdAt: true },
          }),
        ]);

        const memories = dedupeByContent([
          ...(recalled ?? []).map((m) => ({ content: m.content })),
          ...local.map((m) => ({
            content: m.content,
            date: formatUtcDate(m.createdAt),
          })),
        ]);

        const longMemoryUnavailable = recalled === null;

        if (memories.length === 0) {
          return {
            memories: [],
            message: longMemoryUnavailable
              ? "Long-term memory could not be reached, and no recent chat memory matched. Do not conclude that nothing is known — say the lookup failed."
              : "No matching memories found.",
          };
        }

        return longMemoryUnavailable
          ? {
              memories,
              message:
                "Long-term memory could not be reached; these are recent chat memories only.",
            }
          : { memories };
      } catch (error) {
        logger.error("Failed to search memories", { error });
        return {
          error: "Failed to search memories",
        };
      }
    },
  });

export type SearchMemoriesTool = InferUITool<
  ReturnType<typeof searchMemoriesTool>
>;

export const saveMemoryTool = ({
  email,
  emailAccountId,
  chatId,
  logger,
  existingSubjects,
}: {
  email: string;
  emailAccountId: string;
  chatId?: string;
  logger: Logger;
  /**
   * Live subject keys for this account. Supersession resolves on exact
   * subject match, so a model that coins a second name for a slot it already
   * has silently keeps both facts. Static examples in the description could
   * not fix that; the account's real keys can.
   */
  existingSubjects: string[];
}) =>
  tool({
    description:
      "Save a memory for future conversations. Use when the user asks you to remember something or when you identify a durable preference worth saving (e.g., workflow preferences, important contacts, inbox management style)." +
      (existingSubjects.length
        ? `\n\nExisting keys for this account — reuse one whenever the fact is about the same thing: ${existingSubjects.join(", ")}.`
        : ""),
    inputSchema: z.object({
      content: z
        .string()
        .trim()
        .min(1)
        .max(1000)
        .describe(
          "The memory content to save. Should be a clear, self-contained statement of the preference or fact.",
        ),
      subject: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:[._][a-z0-9]+)*$/)
        .max(60)
        .optional()
        .describe(
          "Stable snake_case slot this fact occupies, so a later fact about the same thing replaces it instead of contradicting it. " +
            "Reuse an existing key whenever the fact is about the same thing: digest.schedule, working_hours, timezone, signature, courier. " +
            "Coin a new one only for a genuinely new slot, and keep it narrow enough that two facts sharing it really are mutually exclusive — " +
            "courier.domestic and courier.international are different slots. Omit it for a one-off fact that nothing could later contradict.",
        ),
    }),
    execute: async ({ content, subject }) => {
      logger.trace("Tool call: save_memory", { email });
      try {
        const result = await saveMemory({
          emailAccountId,
          content,
          subject,
          chatId,
          logger,
        });

        // Mirrored, not moved: ChatMemory stays the store the UI lists and the
        // one that survives long memory being unreachable. Ingest runs even on
        // the dedupe path so a row saved before this existed still gets indexed
        // the next time the agent tries to save it.
        await ingestMemory({
          emailAccountId,
          text: content,
          source: "inbox-zero-chat",
          logger,
        });

        return {
          success: true,
          content,
          deduplicated: result.deduplicated,
          ...(result.supersededCount > 0 && {
            replaced: result.supersededCount,
          }),
          // Say so rather than reporting a clean save: the fact is stored but
          // is not what the agent will recall, and silently implying otherwise
          // is how a correction appears to work and doesn't.
          ...(result.bornSuperseded && {
            note: "Saved as historical. A newer or user-stated fact already occupies this subject, so this will not be recalled as current.",
          }),
        };
      } catch (error) {
        logger.error("Failed to save memory", { error });
        return {
          error: "Failed to save memory",
        };
      }
    },
  });

export type SaveMemoryTool = InferUITool<ReturnType<typeof saveMemoryTool>>;

function dedupeByContent<T extends { content: string }>(memories: T[]): T[] {
  const seen = new Map<string, T>();

  for (const memory of memories) {
    const key = memory.content.trim().toLowerCase();
    if (!seen.has(key)) seen.set(key, memory);
  }

  return [...seen.values()];
}
