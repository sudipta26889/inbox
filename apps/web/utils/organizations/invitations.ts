import { sendInvitationEmail } from "@inboxzero/resend";
import { generateSecureToken } from "@/utils/api-key";
import { env } from "@/env";

/**
 * Domains that must never receive live invitation email.
 *
 * Includes RFC 2606 / special-use names and `test.com`, which is a common
 * fixture address (`user@test.com`) and is not a safe deliverability target.
 */
const RESERVED_INVITATION_DOMAINS = new Set([
  "test",
  "example",
  "invalid",
  "localhost",
  "test.com",
  "example.com",
  "example.org",
  "example.net",
]);

/**
 * Return whether an address is a reserved/test recipient that must not be emailed.
 *
 * @param email - Candidate invitation recipient.
 * @returns True when the domain is reserved or a special-use label.
 */
export function isReservedInvitationRecipient(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) {
    return true;
  }

  const domain = normalized.slice(at + 1);
  if (RESERVED_INVITATION_DOMAINS.has(domain)) {
    return true;
  }

  const labels = domain.split(".");
  const tld = labels[labels.length - 1];
  return RESERVED_INVITATION_DOMAINS.has(tld);
}

/**
 * Reject reserved/test invitation recipients before any live send.
 *
 * @param email - Candidate invitation recipient.
 * @throws {Error} When the recipient domain is reserved for tests/docs.
 */
export function assertDeliverableInvitationEmail(email: string): void {
  if (isReservedInvitationRecipient(email)) {
    throw new Error(
      `Refusing to send invitation email to reserved/test address: ${email}`,
    );
  }
}

/**
 * Send an organization invitation email through Resend.
 *
 * @param args - Invitation delivery arguments.
 * @param args.email - Recipient address.
 * @param args.organizationName - Organization display name.
 * @param args.inviterName - Inviter display name.
 * @param args.invitationId - Invitation record id used in the accept URL.
 */
export async function sendOrganizationInvitation({
  email,
  organizationName,
  inviterName,
  invitationId,
}: {
  email: string;
  organizationName: string;
  inviterName: string;
  invitationId: string;
}) {
  assertDeliverableInvitationEmail(email);

  const unsubscribeToken = generateSecureToken();

  await sendInvitationEmail({
    from: env.RESEND_FROM_EMAIL,
    to: email,
    emailProps: {
      baseUrl: env.NEXT_PUBLIC_BASE_URL,
      organizationName,
      inviterName,
      invitationId,
      unsubscribeToken,
    },
  });
}
