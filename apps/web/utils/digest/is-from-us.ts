import { env } from "@/env";
import { extractEmailAddress } from "@/utils/email";

// Digest emails must never summarize our own outgoing mail (e.g. the digest
// itself landing back in the inbox). Compare bare addresses because the
// header and the env values may differ in display-name formatting.
export function isOwnSendingAddress(from: string): boolean {
  const fromAddress = extractEmailAddress(from).toLowerCase();
  if (!fromAddress) return false;

  return [env.SMTP_FROM_EMAIL, env.RESEND_FROM_EMAIL]
    .filter((value): value is string => Boolean(value))
    .some((our) => extractEmailAddress(our).toLowerCase() === fromAddress);
}
