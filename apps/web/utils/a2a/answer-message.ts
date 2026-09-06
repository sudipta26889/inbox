import "server-only";
import {
  convertToModelMessages,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { aiProcessAssistantChat } from "@/utils/ai/assistant/chat";
import { loadAgentContext } from "@/utils/ai/assistant/agent-context";
import type { Logger } from "@/utils/logger";
import { getEmailAccountWithAi } from "@/utils/user/get";

/**
 * Answer a plain-text A2A message.
 *
 * Before this, a message with no `skill` was written to A2aMessage and the call
 * returned a messageId — no model, no tool, no answer. Since every advertised
 * skill needs an explicit `skill` + `input`, and OpenClaw (like anything
 * speaking plain A2A) sends only text parts, every question a peer asked was
 * silently dropped behind an HTTP 200.
 *
 * The agent runs READ-ONLY here. A peer holding a token is not the account
 * owner, so it gets the reasoning and the read tools, never the write ones —
 * the same footing the unattended digest runs on.
 */

const MAX_ANSWER_CHARS = 4000;

export async function answerA2aMessage({
  emailAccountId,
  question,
  contextId,
  logger,
}: {
  emailAccountId: string;
  question: string;
  contextId: string;
  logger: Logger;
}): Promise<string | null> {
  const user = await getEmailAccountWithAi({ emailAccountId });

  if (!user?.account?.provider) {
    logger.warn("Cannot answer A2A message: account has no provider", {
      emailAccountId,
    });
    return null;
  }

  const { inboxStats, memories } = await loadAgentContext({
    emailAccountId,
    provider: user.account.provider,
    surface: "A2A peer message",
    logger,
  });

  const userMessage: UIMessage = {
    id: `a2a-${contextId}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: `${question}\n\nAnswer in at most ${MAX_ANSWER_CHARS} characters. You are replying to another agent, not a person — no greetings, no follow-up questions.`,
      },
    ],
  };

  const result = await aiProcessAssistantChat({
    messages: await convertToModelMessages([userMessage]),
    emailAccountId,
    user,
    memories,
    inboxStats,
    responseSurface: "messaging",
    readOnly: true,
    logger,
  });

  const stream = result.toUIMessageStream<UIMessage>({
    originalMessages: [userMessage],
    generateMessageId: () => `${userMessage.id}-assistant`,
  });

  let assistant: UIMessage | null = null;
  for await (const message of readUIMessageStream<UIMessage>({ stream })) {
    if (message.role === "assistant") assistant = message;
  }

  const text = (assistant?.parts ?? [])
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();

  return text || null;
}

/** Pull the question out of whatever shape the peer sent. */
export function extractQuestion(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;

  if (content && typeof content === "object") {
    const text = (content as { text?: unknown }).text;
    if (typeof text === "string") return text.trim() || null;
  }

  return null;
}
