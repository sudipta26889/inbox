import { convertToModelMessages, type UIMessage } from "ai";
import { withEmailAccount } from "@/utils/middleware";
import { getEmailAccountWithAi } from "@/utils/user/get";
import { NextResponse } from "next/server";
import { aiProcessAssistantChat } from "@/utils/ai/assistant/chat";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { Prisma } from "@/generated/prisma/client";
import { convertToUIMessages } from "@/components/assistant-chat/helpers";
import { captureException } from "@/utils/error";
import {
  shouldCompact,
  compactMessages,
  extractMemories,
  RECENT_MESSAGES_TO_KEEP,
} from "@/utils/ai/assistant/compact";
import {
  loadAgentContext,
  memoryQueryFromParts,
} from "@/utils/ai/assistant/agent-context";
import { mapUiMessagesToChatMessageRows } from "@/app/api/chat/chat-message-persistence";
import {
  type AssistantInput,
  assistantInputSchema,
} from "@/utils/actions/assistant-chat.validation";
import { buildInlineEmailActionSystemMessage } from "@/utils/ai/assistant/inline-email-actions";

export const maxDuration = 120;

export const POST = withEmailAccount("chat", async (request) => {
  const emailAccountId = request.auth.emailAccountId;

  const user = await getEmailAccountWithAi({ emailAccountId });

  if (!user) return NextResponse.json({ error: "Not authenticated" });

  const json = await request.json();
  const { data, error } = assistantInputSchema.safeParse(json);

  if (error) return NextResponse.json({ error: error.errors }, { status: 400 });

  const chat =
    (await getChatWithCompactions(data.id)) ||
    (await createNewChat({
      emailAccountId,
      chatId: data.id,
      logger: request.logger,
    }));

  if (!chat) {
    return NextResponse.json(
      { error: "Failed to get or create chat" },
      { status: 500 },
    );
  }

  if (chat.emailAccountId !== emailAccountId) {
    return NextResponse.json(
      { error: "You are not authorized to access this chat" },
      { status: 403 },
    );
  }

  const { message, context, inlineActions } = data;

  const agentContextPromise = loadAgentContext({
    emailAccountId,
    provider: user.account.provider,
    surface: "web chat",
    query: memoryQueryFromParts(message.parts),
    logger: request.logger,
  });

  const hiddenInlineActionMessage =
    buildHiddenInlineActionMessage(inlineActions);

  await saveChatMessage({
    chat: { connect: { id: chat.id } },
    id: message.id,
    role: "user",
    parts: message.parts,
  });

  const latestCompaction = chat.compactions[0];

  const messagesForModel = latestCompaction
    ? chat.messages.filter(
        (m) => m.createdAt >= latestCompaction.compactedBeforeCreatedAt,
      )
    : chat.messages;

  const uiMessages = [
    ...dropOrphanToolCalls(
      convertToUIMessages({ ...chat, messages: messagesForModel }),
    ),
    ...(hiddenInlineActionMessage ? [hiddenInlineActionMessage] : []),
    message,
  ];

  let modelMessages = await convertToModelMessages(uiMessages);

  if (latestCompaction) {
    modelMessages = [
      {
        role: "system" as const,
        content: `Summary of earlier conversation:\n${latestCompaction.summary}`,
      },
      ...modelMessages,
    ];
  }

  if (shouldCompact(modelMessages)) {
    try {
      const preCompactionMessages = modelMessages;

      const { compactedMessages, summary, compactedCount } =
        await compactMessages({
          messages: modelMessages,
          user,
          logger: request.logger,
        });

      if (compactedCount > 0 && summary.trim().length > 0) {
        modelMessages = compactedMessages;

        // Compute boundary: keep at least RECENT_MESSAGES_TO_KEEP DB messages.
        // messagesForModel doesn't include the new user message (saved after query),
        // so we keep RECENT_MESSAGES_TO_KEEP from the existing set.
        const keepFromIndex = Math.max(
          0,
          messagesForModel.length - RECENT_MESSAGES_TO_KEEP,
        );
        const compactedBeforeCreatedAt =
          messagesForModel[keepFromIndex]?.createdAt ?? new Date();

        const [, memories] = await Promise.all([
          prisma.$transaction([
            prisma.chatCompaction.create({
              data: {
                chatId: chat.id,
                summary,
                messageCount: compactedCount,
                compactedBeforeCreatedAt,
              },
            }),
            prisma.chat.update({
              where: { id: chat.id },
              data: { compactionCount: { increment: 1 } },
            }),
          ]),
          extractMemories({
            messages: preCompactionMessages,
            user,
          }).catch((err) => {
            request.logger.error("Failed to extract memories", {
              error: err,
            });
            return [];
          }),
        ]);

        if (memories.length > 0) {
          await prisma.chatMemory.createMany({
            data: memories.map((m) => ({
              content: m.content,
              chatId: chat.id,
              emailAccountId,
            })),
            skipDuplicates: true,
          });
        }
      }
    } catch (compactionError) {
      request.logger.error(
        "Chat compaction failed, continuing with full history",
        {
          error: compactionError,
        },
      );
    }
  }

  try {
    const { inboxStats, memories } = await agentContextPromise;

    const result = await aiProcessAssistantChat({
      messages: modelMessages,
      emailAccountId,
      user,
      context,
      chatId: chat.id,
      memories,
      inboxStats,
      logger: request.logger,
    });

    return result.toUIMessageStreamResponse({
      onFinish: async ({ messages }) => {
        await saveChatMessages(messages, chat.id, request.logger);
      },
    });
  } catch (error) {
    request.logger.error("Error in assistant chat", { error });
    return NextResponse.json(
      { error: "Error in assistant chat" },
      { status: 500 },
    );
  }
});

async function createNewChat({
  emailAccountId,
  chatId,
  logger,
}: {
  emailAccountId: string;
  chatId: string;
  logger: Logger;
}) {
  try {
    const newChat = await prisma.chat.create({
      data: { emailAccountId, id: chatId },
      include: {
        messages: { orderBy: { createdAt: "asc" } },
        compactions: { orderBy: { createdAt: "desc" }, take: 1 },
      },
    });
    logger.info("New chat created", { chatId: newChat.id, emailAccountId });
    return newChat;
  } catch (error) {
    logger.error("Failed to create new chat", { error, emailAccountId });
    return undefined;
  }
}

async function getChatWithCompactions(chatId: string) {
  return prisma.chat.findUnique({
    where: { id: chatId },
    include: {
      messages: { orderBy: { createdAt: "asc" } },
      compactions: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
}

async function saveChatMessage(message: Prisma.ChatMessageCreateInput) {
  return prisma.chatMessage.create({ data: message });
}

async function saveChatMessages(
  messages: UIMessage[],
  chatId: string,
  logger: Logger,
) {
  try {
    return prisma.chatMessage.createMany({
      data: mapUiMessagesToChatMessageRows(messages, chatId),
      skipDuplicates: true,
    });
  } catch (error) {
    logger.error("Failed to save chat messages", { error, chatId });
    captureException(error, { extra: { chatId } });
    throw error;
  }
}

function buildHiddenInlineActionMessage(
  inlineActions?: AssistantInput["inlineActions"],
) {
  const text = buildInlineEmailActionSystemMessage(inlineActions);
  if (!text) return null;

  return {
    id: crypto.randomUUID(),
    role: "system" as const,
    parts: [{ type: "text" as const, text }],
  } satisfies UIMessage;
}

// ponytail: strip assistant tool-call parts whose tool never resolved. Happens
// when a stream crashes mid-turn (Ollama Cloud drops, SDK errors, etc.) —
// the tool_call is persisted with state "input-available" but no matching
// tool_result. Reloading such a chat throws AI_MissingToolResultsError before
// the model is ever called, permanently bricking the conversation. Drop the
// orphan part so the assistant turn either has other content or becomes empty
// (which convertToModelMessages tolerates).
function dropOrphanToolCalls(messages: UIMessage[]): UIMessage[] {
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const parts = m.parts.filter((p) => {
      const type = (p as { type?: string }).type ?? "";
      if (!type.startsWith("tool-")) return true;
      const state = (p as { state?: string }).state;
      return state === "output-available" || state === "output-error";
    });
    return { ...m, parts };
  });
}
