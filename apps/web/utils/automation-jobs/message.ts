import { aiGenerateAutomationCheckInMessage } from "@/utils/ai/automation-jobs/generate-check-in-message";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";

export async function getAutomationJobMessage({
  prompt,
  emailAccountId,
  emailProvider,
  logger,
}: {
  prompt: string | null;
  emailAccountId: string;
  emailProvider: EmailProvider;
  logger: Logger;
}) {
  const trimmedPrompt = prompt?.trim();

  // No silent fallback: echoing the prompt back looks like the check-in worked
  // when it didn't. Let it throw so the run is recorded FAILED and retried.
  if (trimmedPrompt) {
    return await aiGenerateAutomationCheckInMessage({
      prompt: trimmedPrompt,
      emailAccountId,
      logger,
    });
  }

  try {
    const stats = await emailProvider.getInboxStats();

    if (stats.unread === 0) {
      return "Your inbox looks clear right now. Want me to keep monitoring and ping again later?";
    }

    return `You currently have ${stats.unread} unread emails. Want to go through them now?`;
  } catch (error) {
    logger.warn("Failed to read inbox stats for automation message", {
      error,
    });

    return "I checked in on your inbox. Want to triage emails now?";
  }
}
