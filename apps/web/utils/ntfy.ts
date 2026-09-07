import "server-only";
import { env } from "@/env";
import { isAdmin } from "@/utils/admin";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Push notifications to the account owner's phone via ntfy.
 *
 * Fail-soft on the same reasoning as the MQTT client: a notification server
 * being down must never fail the rule execution or cron run that triggered it.
 * Every failure path here logs and returns.
 *
 * This is NOT the A2A §3.1.7 push transport. That one is peer-facing, where a
 * remote agent registers its own callback URL. This is one private topic
 * belonging to the operator, and nothing a peer sends can reach it.
 *
 * ponytail: one instance-wide topic, no per-user routing. Every caller must
 * gate on isOwnerEmailAccount first, because a second user's subject line on
 * the owner's phone is a real leak. Upgrade path is a per-account topic column
 * alongside mqttTopicSlug, if this instance ever has non-owner users.
 */

const logger = createScopedLogger("ntfy");

const TIMEOUT_MS = 5000;

export function isNtfyEnabled(): boolean {
  return Boolean(env.NTFY_BASE_URL && env.NTFY_TOPIC);
}

export async function notifyOwner({
  title,
  message,
  priority = 3,
  tags,
  click,
}: {
  title: string;
  message: string;
  /** ntfy scale: 1 min … 5 max. 3 is the default. */
  priority?: 1 | 2 | 3 | 4 | 5;
  tags?: string[];
  click?: string;
}): Promise<void> {
  if (!isNtfyEnabled()) return;

  try {
    const response = await fetch(`${env.NTFY_BASE_URL}/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        ...(env.NTFY_TOKEN
          ? { Authorization: `Bearer ${env.NTFY_TOKEN}` }
          : {}),
        Title: headerSafe(title),
        Priority: String(priority),
        ...(tags?.length ? { Tags: headerSafe(tags.join(",")) } : {}),
        ...(click ? { Click: headerSafe(click) } : {}),
      },
      body: message,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // A refusal arrives as a successful round-trip, so fetch does not reject
    // and nothing downstream would ever notice a 403 on the topic.
    if (!response.ok) {
      logger.warn("ntfy refused the notification", {
        status: response.status,
        body: (await response.text()).slice(0, 200),
      });
    }
  } catch (error) {
    logger.warn("Could not reach ntfy", { error });
  }
}

/**
 * Whether this account belongs to an operator listed in ADMINS.
 *
 * The ntfy topic is instance-wide. Without this gate, a second user's urgent
 * mail would push its subject line to the operator's phone.
 */
export async function isOwnerEmailAccount(
  emailAccountId: string,
): Promise<boolean> {
  if (!isNtfyEnabled()) return false;

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { user: { select: { email: true } } },
  });

  return Boolean(isAdmin({ email: account?.user.email }));
}

function headerSafe(value: string): string {
  // Title, Tags and Click become HTTP headers. A subject line carrying CRLF
  // would inject headers into our own request.
  return value.replace(/[\r\n]+/g, " ").slice(0, 200);
}
