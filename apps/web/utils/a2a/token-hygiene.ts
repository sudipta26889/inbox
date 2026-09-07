import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { TOKEN_CONFIG } from "@/utils/mcp-server/constants";

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
  reason: "expiring" | "stale";
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

/**
 * Delete access tokens that are certainly dead: expired, or revoked, long
 * enough ago.
 *
 * Measured before this existed: 5657 rows backing 1 live token. Nothing had
 * ever pruned the table. Revocation gets its own clock (`revokedAt`) instead
 * of riding on `expiresAt`, because revoking a token never backdates its
 * expiry — the two columns are independent. Peer tokens are minted with
 * multi-year TTLs (see apps/web/scripts/mint-a2a-token.ts), so without this a
 * revoked row from a long-lived credential would sit for a decade waiting on
 * an expiry date that revocation already made irrelevant.
 *
 * The grace period applies to both clocks: a token that expired or was
 * revoked an hour ago may still be mid-refresh on the peer's side, and
 * deleting the row loses the audit trail of a rotation that is still in
 * flight.
 *
 * The grace period must stay >= TOKEN_CONFIG.REFRESH_TOKEN_TTL: the refresh
 * token lives on this same row as the access token, so a shorter grace
 * would delete a row whose refresh token is still valid, silently signing
 * that peer out on its next refresh. Derived from REFRESH_TOKEN_TTL itself
 * (currently 30 days) rather than repeated as a literal, so the two can
 * never drift apart.
 */
const REFRESH_TOKEN_TTL_DAYS = Math.ceil(
  TOKEN_CONFIG.REFRESH_TOKEN_TTL / (24 * 60 * 60),
);

export async function cleanupExpiredAccessTokens(
  daysToKeep = REFRESH_TOKEN_TTL_DAYS,
): Promise<number> {
  const threshold = new Date(Date.now() - daysToKeep * DAY_MS);

  const result = await prisma.mcpServerAccessToken.deleteMany({
    where: {
      OR: [{ expiresAt: { lt: threshold } }, { revokedAt: { lt: threshold } }],
    },
  });

  return result.count;
}
