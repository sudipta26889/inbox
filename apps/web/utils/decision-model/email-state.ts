import type { EmailForLLM } from "@/utils/types";
import { sliceHead } from "@/utils/string";

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
    content: sliceHead(email.content, maxContentLength),
    date: email.date?.toISOString() ?? null,
    hasListUnsubscribeHeader: !!email.listUnsubscribe,
    attachments:
      email.attachments?.map((attachment) => attachment.filename) ?? [],
  };
}
