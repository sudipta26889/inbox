import {
  convertToModelMessages,
  readUIMessageStream,
  type UIMessage,
} from "ai";
import { loadAgentContext } from "@/utils/ai/assistant/agent-context";
import { aiProcessAssistantChat } from "@/utils/ai/assistant/chat";
import type { Logger } from "@/utils/logger";
import { getEmailAccountWithAi } from "@/utils/user/get";

// Telegram truncates at 4096 chars; leave room for the account header.
const MAX_MESSAGE_CHARS = 3500;

export async function aiGenerateAutomationCheckInMessage({
  prompt,
  emailAccountId,
  logger,
}: {
  prompt: string;
  emailAccountId: string;
  logger: Logger;
}) {
  const aiLogger = logger.with({
    component: "aiGenerateAutomationCheckInMessage",
  });

  const trimmedPrompt = prompt.trim();
  if (!trimmedPrompt) throw new Error("Automation check-in prompt is required");

  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount?.account?.provider) {
    throw new Error("Email account is not connected to a provider");
  }

  const { inboxStats, memories } = await loadAgentContext({
    emailAccountId,
    provider: emailAccount.account.provider,
    surface: "scheduled check-in",
    query: trimmedPrompt,
    logger,
  });

  const userMessage: UIMessage = {
    id: `check-in-${emailAccountId}`,
    role: "user",
    parts: [
      {
        type: "text",
        text: `${trimmedPrompt}\n\nThis is an unattended scheduled check-in. Answer in at most ${MAX_MESSAGE_CHARS} characters. Do not ask me to confirm anything — I cannot reply to this run.`,
      },
    ],
  };

  const result = await aiProcessAssistantChat({
    messages: await convertToModelMessages([userMessage]),
    emailAccountId,
    user: emailAccount,
    memories,
    inboxStats,
    responseSurface: "messaging",
    readOnly: true,
    logger: aiLogger,
  });

  const stream = result.toUIMessageStream<UIMessage>({
    originalMessages: [userMessage],
    generateMessageId: () => `${userMessage.id}-assistant`,
  });

  let assistantMessage: UIMessage | null = null;
  for await (const message of readUIMessageStream<UIMessage>({ stream })) {
    if (message.role === "assistant") assistantMessage = message;
  }

  const text = (assistantMessage?.parts ?? [])
    .flatMap((part) =>
      part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n")
    .trim();

  if (!text) throw new Error("Assistant returned an empty check-in message");

  aiLogger.info("Generated automation check-in message", {
    length: text.length,
  });

  return text;
}
