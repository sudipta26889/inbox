import type { gmail_v1 } from "@googleapis/gmail";
import { GmailLabel } from "@/utils/gmail/label";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import { isOutboundThreadStatusProcessed } from "@/utils/redis/outbound-thread-status";
import { processHistoryItem } from "@/utils/webhook/process-history-item";

const SENT_BATCH_SIZE = 50;
const CLAIM_TTL_SECONDS = 60 * 60 * 24 * 3;

// Polling lists only unread inbox mail, so until Gmail push went live every
// reply sent from Gmail skipped outbound handling and its NEEDS_REPLY tracker
// never resolved. Push covers it now; this keeps the backup path correct too.
export async function processRecentSentMessages({
  gmail,
  emailAccountId,
  options,
  logger,
}: {
  gmail: gmail_v1.Gmail;
  emailAccountId: string;
  options: Parameters<typeof processHistoryItem>[1];
  logger: Logger;
}) {
  const response = await gmail.users.messages.list({
    userId: "me",
    labelIds: [GmailLabel.SENT],
    q: "newer_than:1d",
    maxResults: SENT_BATCH_SIZE,
  });

  let processed = 0;
  for (const message of response.data.messages ?? []) {
    if (!message.id || !message.threadId) continue;

    const key = {
      emailAccountId,
      threadId: message.threadId,
      messageId: message.id,
    };
    if (await isOutboundThreadStatusProcessed(key)) continue;

    // At most once from polling even when outbound handling bails before
    // marking (no enabled status rule, AI error) — else every 30-min poll
    // would pay for the same AI call again.
    const claimed = await redis.set(
      `poll-outbound:${emailAccountId}:${message.id}`,
      "1",
      { ex: CLAIM_TTL_SECONDS, nx: true },
    );
    if (!claimed) continue;

    try {
      await processHistoryItem(
        { messageId: message.id, threadId: message.threadId },
        options,
      );
      processed += 1;
    } catch (error) {
      logger.error("Failed to process sent message", {
        messageId: message.id,
        error,
      });
    }
  }

  return processed;
}
