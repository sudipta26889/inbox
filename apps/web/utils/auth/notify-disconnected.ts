import { env } from "@/env";
import {
  getRemoteAgentUrls,
  resolveA2aEndpoint,
  sendA2aMessage,
} from "@/utils/a2a-client";
import type { Logger } from "@/utils/logger";
import { redis } from "@/utils/redis";

const DEDUPE_SECONDS = 12 * 60 * 60;

/**
 * Tells the outbound A2A agents (Mitra -> Telegram) at once that a mailbox lost
 * its login, instead of waiting for the next morning report. Never throws: the
 * token cleanup must not fail because the alert failed.
 */
export async function notifyMailboxDisconnected({
  email,
  emailAccountId,
  reason,
  logger,
}: {
  email: string;
  emailAccountId: string;
  reason: string;
  logger: Logger;
}) {
  try {
    const agentUrls = getRemoteAgentUrls();
    if (!agentUrls.length) {
      logger.info("No remote A2A agents configured, skipping disconnect alert");
      return;
    }

    const dedupeKey = `mailbox-disconnect-alert:${emailAccountId}`;
    const firstAlert = await redis.set(dedupeKey, "1", {
      nx: true,
      ex: DEDUPE_SECONDS,
    });
    if (!firstAlert) {
      logger.info("Disconnect alert already sent recently, skipping");
      return;
    }

    const now = new Date();
    const date = now.toISOString().slice(0, 10);

    const results = await Promise.allSettled(
      agentUrls.map(async (agentUrl) => {
        const endpoint = await resolveA2aEndpoint(agentUrl);
        const result = await sendA2aMessage(endpoint, {
          text: `Inbox lost access to ${email} (${reason}). Mail from it is not being processed. Reconnect: ${env.NEXT_PUBLIC_BASE_URL}/accounts`,
          data: {
            kind: "inbox.mailbox_disconnected",
            email,
            email_account_id: emailAccountId,
            reason,
            at: now.toISOString(),
          },
          contextId: `inbox-disconnect-${emailAccountId}-${date}`,
        });
        if (result.error) throw new Error(result.error.message);
      }),
    );

    for (const result of results) {
      if (result.status === "rejected") {
        logger.error("Failed to send disconnect alert", {
          error: result.reason,
        });
      }
    }

    // Nobody received it, so release the dedupe key and let the next disconnect retry.
    if (results.every((result) => result.status === "rejected")) {
      await redis.del(dedupeKey);
    }
  } catch (error) {
    logger.error("Failed to send disconnect alert", { error });
  }
}
