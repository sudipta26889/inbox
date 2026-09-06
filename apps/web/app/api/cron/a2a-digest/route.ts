import { NextResponse } from "next/server";
import {
  buildDailyDigest,
  getLocalDate,
  getLocalHour,
  pushDailyDigestToRemoteAgents,
  saveDailyDigest,
} from "@/utils/a2a/daily-digest";
import { hasCronSecret } from "@/utils/cron";
import { captureException } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { withError } from "@/utils/middleware";
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

  const result = await runDueDigests(request.logger);
  return NextResponse.json(result);
});

async function runDueDigests(logger: Logger) {
  const emailAccounts = await prisma.emailAccount.findMany({
    select: { userId: true, timezone: true },
    orderBy: { createdAt: "asc" },
  });

  const timeZoneByUser = new Map<string, string>();
  for (const emailAccount of emailAccounts) {
    if (!timeZoneByUser.has(emailAccount.userId)) {
      timeZoneByUser.set(emailAccount.userId, emailAccount.timezone || "UTC");
    }
  }

  let generated = 0;
  let skipped = 0;
  let failed = 0;

  for (const [userId, timeZone] of timeZoneByUser) {
    const userLogger = logger.with({ userId, timeZone });

    if (getLocalHour(timeZone) !== DIGEST_HOUR) {
      skipped += 1;
      continue;
    }

    const date = getLocalDate(timeZone);
    const latchKey = `a2a-digest:latch:${userId}:${date}`;
    const claimed = await redis.set(latchKey, new Date().toISOString(), {
      ex: LATCH_TTL_SECONDS,
      nx: true,
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
      failed += 1;
    }
  }

  logger.info("Finished daily digest run", {
    users: timeZoneByUser.size,
    generated,
    skipped,
    failed,
  });

  return { users: timeZoneByUser.size, generated, skipped, failed };
}
