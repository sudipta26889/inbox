import type { IssueLinkInput } from "@/utils/taskpilot/types";

/**
 * The "Inbox thread" link every TaskPilot work item created from an email
 * carries. Shared by the create path and the backfill so both produce the
 * same link for the same email.
 */
export function buildInboxThreadLinkInput({
  deepLink,
  threadId,
  emailAccountId,
  messageId,
}: {
  deepLink: string;
  threadId: string | null;
  emailAccountId: string;
  messageId: string;
}): IssueLinkInput {
  return {
    title: "Inbox thread",
    url: deepLink,
    metadata: {
      threadId,
      emailAccountId,
      gmailMessageId: messageId,
    },
  };
}
