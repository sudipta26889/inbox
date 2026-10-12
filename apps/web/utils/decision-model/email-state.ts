import type { EmailForLLM } from "@/utils/types";

// Backport of upstream inbox-zero `utils/decision-model/email-state.ts`.
export function getDecisionEmailState(
  email: EmailForLLM,
  maxContentLength: number,
) {
  return {
    from: email.from,
    to: email.to,
    cc: email.cc ?? null,
    replyTo: email.replyTo ?? null,
    subject: email.subject,
    content: email.content.slice(0, maxContentLength),
    date: email.date?.toISOString() ?? null,
    hasListUnsubscribeHeader: !!email.listUnsubscribe,
    attachments:
      email.attachments?.map((attachment) => attachment.filename) ?? [],
  };
}
