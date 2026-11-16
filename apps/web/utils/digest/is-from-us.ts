import { env } from "@/env";
import { extractEmailAddress } from "@/utils/email";

// Digest emails must never summarize our own outgoing mail (e.g. the digest
// itself landing back in the inbox). Compare bare addresses because the
// header and the env value may differ in display-name formatting.
export function isOwnSendingAddress(from: string): boolean {
  const fromAddress = extractEmailAddress(from).toLowerCase();
  if (!fromAddress || !env.RESEND_FROM_EMAIL) return false;

  return extractEmailAddress(env.RESEND_FROM_EMAIL).toLowerCase() === fromAddress;
}
