import { NextResponse } from "next/server";
import { alertDigestFailure, recordDigestRun } from "@/utils/a2a/digest-report";
import {
  buildDailyDigest,
  getLocalDate,
  getLocalHour,
  pushDailyDigestToRemoteAgents,
  saveDailyDigest,
} from "@/utils/a2a/daily-digest";
import { isAdmin } from "@/utils/admin";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { withError } from "@/utils/middleware";
import { publishDigest } from "@/utils/mqtt/events";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";

export const maxDuration = 300;

// The cron container polls on a fixed interval rather than at exact times, so
// this route fires on the first poll inside the target hour and a Redis latch
// keeps the rest of the hour idempotent.
const DIGEST_HOUR = 5;
const LATCH_TTL_SECONDS = 60 * 60 * 26;

export const GET = withError("cron/a2a-digest", async (request) => {
  if (!hasCronSecret(request)) {
    captureException(new Error("Unauthorized request: api/cron/a2a-digest"));
    return new Response("Unauthorized", { status: 401 });
  }

  // ?force=true runs now regardless of the hour, and regenerates even if today
  // already ran. Same cron-secret gate; for verifying the path without waiting
  // for 05:00 local.
  const force = new URL(request.url).searchParams.get("force") === "true";

  const result = await runDueDigests(request.logger, { force });
  return NextResponse.json(result);
});

async function runDueDigests(logger: Logger, { force = false } = {}) {
  // Owners only. `A2A_REMOTE_AGENTS` is instance-wide, so pushing every user's
  // digest to it would hand one user's inbox summary to another user's agent.
  // Widen this only alongside a per-user destination setting.
  const users = await prisma.user.findMany({
    where: { emailAccounts: { some: {} } },
    select: {
      id: true,
      email: true,
      emailAccounts: {
        select: { timezone: true },
        orderBy: { createdAt: "asc" },
        take: 1,
      },
    },
  });

  const owners = users.filter((user) => isAdmin({ email: user.email }));

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const user of owners) {
    const userId = user.id;
    const timeZone = user.emailAccounts[0]?.timezone || "UTC";
    const userLogger = logger.with({ userId, timeZone });

    if (!force && getLocalHour(timeZone) !== DIGEST_HOUR) {
      skipped += 1;
      continue;
    }

    const date = getLocalDate(timeZone);
    const latchKey = `a2a-digest:latch:${userId}:${date}`;
    const claimed = await redis.set(latchKey, new Date().toISOString(), {
      ex: LATCH_TTL_SECONDS,
      nx: !force,
    });

    if (!claimed) {
      userLogger.info("Daily digest already generated today", { date });
      skipped += 1;
      continue;
    }

    try {
      const digest = await buildDailyDigest({
        userId,
        date,
        logger: userLogger,
      });

      if (!digest.accounts.length) {
        throw new Error("No account produced a digest");
      }

      await saveDailyDigest(digest);
      await pushDailyDigestToRemoteAgents({ digest, logger: userLogger });

      // One publish per account in the digest, each gated on that account's
      // own bus opt-in. The catch is load-bearing: publishDigest reads the
      // database to resolve consent, and a blip there must not fail a cron
      // run that has already generated and saved the digest. No structured
      // item count exists in this pipeline, so `items` is left unset rather
      // than guessed from prose line-wrapping.
      for (const account of digest.accounts) {
        await publishDigest({
          emailAccountId: account.emailAccountId,
        }).catch(() => {});
      }

      await recordDigestRun({
        userId: user.id,
        outcome: {
          status: "ok",
          date,
          at: new Date().toISOString(),
          accounts: digest.accounts.length,
          failedAccounts: digest.failures.map((failure) => failure.email),
        },
      });

      userLogger.info("Generated daily digest", {
        date,
        accounts: digest.accounts.length,
        failures: digest.failures.length,
      });
      generated += 1;
    } catch (error) {
      // Release the latch so a later poll inside the same hour can retry.
      await redis.del(latchKey);
      userLogger.error("Failed to generate daily digest", { date, error });

      // The cron container runs this as `curl ... || true`, so nothing else
      // will ever notice this failure.
      const outcome = {
        status: "failed" as const,
        date,
        at: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      await recordDigestRun({ userId: user.id, outcome });
      await alertDigestFailure({
        userId: user.id,
        outcome,
        logger: userLogger,
      });

      failed += 1;
    }
  }

  logger.info("Finished daily digest run", {
    users: users.length,
    owners: owners.length,
    generated,
    skipped,
    failed,
  });

  return {
    users: users.length,
    owners: owners.length,
    generated,
    skipped,
    failed,
  };
}
