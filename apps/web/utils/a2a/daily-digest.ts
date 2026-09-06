import {
  getRemoteAgentUrls,
  resolveA2aEndpoint,
  sendA2aMessage,
} from "@/utils/a2a-client";
import { aiGenerateAutomationCheckInMessage } from "@/utils/ai/automation-jobs/generate-check-in-message";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

// Kept two days so a subscriber that misses a morning can still fetch
// yesterday's. ponytail: Redis with a TTL, not a table — nothing reads this
// back beyond the next day. Move to Prisma if digest history is ever wanted.
const DIGEST_TTL_SECONDS = 60 * 60 * 48;

export const DEFAULT_DIGEST_PROMPT =
  "Give me a brief morning update: anything urgent or time-sensitive, emails still waiting on my reply, and anything I am awaiting a response on that has gone quiet. Keep it short - a few bullet points. If nothing needs attention, say so in one line.";

export type DailyDigest = {
  userId: string;
  date: string;
  generatedAt: string;
  accounts: { emailAccountId: string; email: string; text: string }[];
  failures: { emailAccountId: string; email: string; error: string }[];
};

export async function buildDailyDigest({
  userId,
  date,
  prompt = DEFAULT_DIGEST_PROMPT,
  logger,
}: {
  userId: string;
  date: string;
  prompt?: string;
  logger: Logger;
}): Promise<DailyDigest> {
  const emailAccounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { id: true, email: true },
    orderBy: { createdAt: "asc" },
  });

  const results = await Promise.allSettled(
    emailAccounts.map((emailAccount) =>
      aiGenerateAutomationCheckInMessage({
        prompt,
        emailAccountId: emailAccount.id,
        logger: logger.with({ emailAccountId: emailAccount.id }),
      }),
    ),
  );

  const accounts: DailyDigest["accounts"] = [];
  const failures: DailyDigest["failures"] = [];

  results.forEach((result, index) => {
    const emailAccount = emailAccounts[index];
    if (!emailAccount) return;

    if (result.status === "fulfilled") {
      accounts.push({
        emailAccountId: emailAccount.id,
        email: emailAccount.email,
        text: result.value,
      });
      return;
    }

    const error =
      result.reason instanceof Error
        ? result.reason.message
        : "Failed to generate digest";
    logger.error("Digest generation failed for account", {
      emailAccountId: emailAccount.id,
      error: result.reason,
    });
    failures.push({
      emailAccountId: emailAccount.id,
      email: emailAccount.email,
      error,
    });
  });

  return {
    userId,
    date,
    generatedAt: new Date().toISOString(),
    accounts,
    failures,
  };
}

export function formatDailyDigest(digest: DailyDigest) {
  const sections = digest.accounts.map(
    (account) => `[${account.email}]\n${account.text}`,
  );

  if (digest.failures.length) {
    sections.push(
      `Could not generate a digest for: ${digest.failures
        .map((failure) => failure.email)
        .join(", ")}`,
    );
  }

  return sections.join("\n\n---\n\n");
}

/**
 * Push the digest to the outbound agent allowlist (`A2A_REMOTE_AGENTS`).
 *
 * Deliberately NOT the inbound clients' `A2aWebhookConfig` URLs: those are
 * client-supplied, and `queueWebhook` never checks token validity, so revoking
 * a client's tokens would not stop content going to it. This list lives in env,
 * so turning an agent off is deleting a line.
 */
export async function pushDailyDigestToRemoteAgents({
  digest,
  logger,
}: {
  digest: DailyDigest;
  logger: Logger;
}) {
  const agentUrls = getRemoteAgentUrls();
  if (!agentUrls.length) {
    logger.info("No remote A2A agents configured, skipping digest push");
    return { pushed: 0, failed: 0 };
  }

  const text = formatDailyDigest(digest);

  const results = await Promise.allSettled(
    agentUrls.map(async (agentUrl) => {
      const endpoint = await resolveA2aEndpoint(agentUrl);
      const result = await sendA2aMessage(endpoint, {
        text: `Daily inbox digest for ${digest.date}\n\n${text}`,
        data: {
          kind: "inbox.daily_digest",
          date: digest.date,
          generated_at: digest.generatedAt,
          accounts: digest.accounts.map((account) => ({
            email: account.email,
            text: account.text,
          })),
          failed_accounts: digest.failures.map((failure) => failure.email),
        },
        contextId: `inbox-digest-${digest.date}`,
      });

      if (result.error) throw new Error(result.error.message);
      return result;
    }),
  );

  const failed = results.filter((r) => r.status === "rejected").length;

  logger.info("Pushed daily digest to remote agents", {
    agents: agentUrls.length,
    pushed: agentUrls.length - failed,
    failed,
  });

  return { pushed: agentUrls.length - failed, failed };
}

export async function saveDailyDigest(digest: DailyDigest) {
  await redis.set(getDigestKey(digest.userId, digest.date), digest, {
    ex: DIGEST_TTL_SECONDS,
  });
}

export async function getDailyDigest({
  userId,
  date,
}: {
  userId: string;
  date: string;
}) {
  return redis.get<DailyDigest>(getDigestKey(userId, date));
}

/**
 * Calendar date in a given IANA timezone, as YYYY-MM-DD.
 * Digests are keyed by the user's local day, not UTC's.
 */
export function getLocalDate(timeZone: string, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

export function getLocalHour(timeZone: string, now = new Date()) {
  return Number.parseInt(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      hour12: false,
    }).format(now),
    10,
  );
}

function getDigestKey(userId: string, date: string) {
  return `a2a-digest:${userId}:${date}`;
}
