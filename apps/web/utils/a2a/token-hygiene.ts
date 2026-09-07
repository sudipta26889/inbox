import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

/**
 * Surface long-lived peer credentials that nobody is watching.
 *
 * Static tokens removed the OAuth refresh loop, and with it the only thing that
 * ever forced attention onto a credential. A token minted for ten years is
 * invisible until it breaks or leaks. Two conditions are worth a look:
 *
 *   stale   — issued long ago and not used recently. Either the peer is gone
 *             (dead credential still valid) or something changed silently.
 *   expiring — inside the warning window. Rotation is one command, but only
 *             if someone knows it is due.
 *
 * Reported once a day rather than on every cron tick, so it stays a signal.
 */

const WARN_BEFORE_EXPIRY_DAYS = 30;
const STALE_AFTER_UNUSED_DAYS = 30;
const REPORT_ONCE_PER_SECONDS = 60 * 60 * 20;

const DAY_MS = 24 * 60 * 60 * 1000;

export type TokenHygieneFinding = {
  clientName: string;
  clientId: string;
  reason: "expiring" | "expired" | "stale";
  detail: string;
};

export async function reportA2aTokenHygiene(
  logger: Logger,
): Promise<{ checked: number; findings: TokenHygieneFinding[] }> {
  const now = new Date();

  const tokens = await prisma.mcpServerAccessToken.findMany({
    where: { revoked: false, expiresAt: { gt: now } },
    select: {
      clientId: true,
      createdAt: true,
      expiresAt: true,
      lastUsedAt: true,
      client: { select: { clientName: true, type: true } },
    },
  });

  const a2aTokens = tokens.filter((token) => token.client?.type === "A2A");
  const findings: TokenHygieneFinding[] = [];

  for (const token of a2aTokens) {
    const clientName = token.client?.clientName ?? token.clientId;
    const daysToExpiry = (token.expiresAt.getTime() - now.getTime()) / DAY_MS;

    if (daysToExpiry < 0) {
      findings.push({
        clientName,
        clientId: token.clientId,
        reason: "expired",
        detail: `expired ${Math.floor(-daysToExpiry)}d ago (${token.expiresAt.toISOString().slice(0, 10)})`,
      });
      continue;
    }

    if (daysToExpiry <= WARN_BEFORE_EXPIRY_DAYS) {
      findings.push({
        clientName,
        clientId: token.clientId,
        reason: "expiring",
        detail: `expires in ${Math.floor(daysToExpiry)}d (${token.expiresAt.toISOString().slice(0, 10)})`,
      });
      continue;
    }

    // Only meaningful for credentials old enough to have been used by now.
    const ageDays = (now.getTime() - token.createdAt.getTime()) / DAY_MS;
    if (ageDays < STALE_AFTER_UNUSED_DAYS) continue;

    const lastUsed = token.lastUsedAt ?? token.createdAt;
    const unusedDays = (now.getTime() - lastUsed.getTime()) / DAY_MS;

    if (unusedDays >= STALE_AFTER_UNUSED_DAYS) {
      findings.push({
        clientName,
        clientId: token.clientId,
        reason: "stale",
        detail: `not used for ${Math.floor(unusedDays)}d — revoke it or find out why the peer stopped calling`,
      });
    }
  }

  if (findings.length === 0) {
    return { checked: a2aTokens.length, findings };
  }

  // Once a day, or a 60s cron turns a warning into wallpaper.
  const claimed = await redis.set(
    "a2a-token-hygiene:reported",
    now.toISOString(),
    { ex: REPORT_ONCE_PER_SECONDS, nx: true },
  );

  if (claimed) {
    logger.warn("A2A peer tokens need attention", { findings });
  }

  return { checked: a2aTokens.length, findings };
}
