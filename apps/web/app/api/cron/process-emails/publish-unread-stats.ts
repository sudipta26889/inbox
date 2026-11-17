import type { Logger } from "@/utils/logger";
import { getInboxStatsForChatContext } from "@/utils/ai/assistant/get-inbox-stats-for-chat-context";
import { isMqttConfigured } from "@/utils/mqtt/client";
import { publishUnread } from "@/utils/mqtt/events";

/**
 * Best-effort MQTT publish for one account's unread count.
 *
 * Lives beside the route, not in it: a Next route file may export only HTTP
 * methods and route config. Kept separate so it can be tested in isolation: this call site runs inside the
 * same per-account try/catch as `enqueueBackgroundJob` and the `queued`
 * counter above — a throw here would double-count the account as both queued
 * and failed, logged under a misleading label. Every exit is fail-soft on
 * purpose; nothing here may reject.
 */
export async function publishUnreadStats({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}): Promise<void> {
  // Skip the provider round trip entirely when MQTT isn't configured on this
  // instance at all — no point paying for inbox stats nobody can consume.
  // Per-account consent is still resolved inside publishUnread.
  if (!isMqttConfigured()) return;

  const stats = await getInboxStatsForChatContext({
    emailAccountId,
    provider,
    logger,
  });

  if (!stats) return;

  await publishUnread({
    emailAccountId,
    unread: stats.unread,
    total: stats.total,
  }).catch(() => {});
}
