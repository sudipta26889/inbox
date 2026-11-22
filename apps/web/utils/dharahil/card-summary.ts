import { extractNameFromEmail } from "@/utils/email";

/**
 * The one line an approval card shows in Slack and Telegram, which are cloud
 * services: what is being approved and for whom, by name only. Never an
 * address, subject or body; the reviewer reads those on the dashboard.
 */
export function approvalSummary({
  what,
  preposition,
  name,
}: {
  /** e.g. "a reply", "a calendar event". */
  what: string;
  preposition?: "to" | "with" | "for";
  /** A display name. Use `displayNameOf` to get one from a header. */
  name?: string | null;
}) {
  const person = name?.trim();
  return person && preposition
    ? `Approve ${what} ${preposition} ${person}`
    : `Approve ${what}`;
}

/** The display name in "Name <a@b.com>", or "" when the header has none. */
export function displayNameOf(recipient: string) {
  if (!recipient.includes("<")) return "";
  const name = extractNameFromEmail(recipient).trim();
  return name.includes("@") ? "" : name;
}
