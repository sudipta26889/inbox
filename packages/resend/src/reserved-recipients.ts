/**
 * Domains that must never receive live mail.
 *
 * RFC 2606 / special-use names, plus `test.com` — a real registered domain
 * commonly used as a fixture address (`user@test.com`), so mail to it leaves
 * the network and bounces off a third party rather than looping back.
 */
const RESERVED_DOMAINS = new Set([
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
 * @param email - Candidate recipient.
 * @returns True when the domain is reserved, special-use, or unparseable.
 */
export function isReservedRecipient(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  if (at <= 0 || at === normalized.length - 1) return true;

  const domain = normalized.slice(at + 1);
  if (RESERVED_DOMAINS.has(domain)) return true;

  return RESERVED_DOMAINS.has(domain.slice(domain.lastIndexOf(".") + 1));
}

/**
 * Reject reserved/test recipients before any live send.
 *
 * Throws rather than returning, so the stack trace names the calling sender.
 *
 * @param email - Candidate recipient.
 * @throws {Error} When the recipient domain is reserved for tests/docs.
 */
export function assertDeliverableRecipient(email: string): void {
  if (isReservedRecipient(email)) {
    throw new Error(`Refusing to send mail to reserved/test address: ${email}`);
  }
}
