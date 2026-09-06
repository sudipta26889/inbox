import {
  getDailyDigest,
  getLocalDate,
  type DailyDigest,
} from "@/utils/a2a/daily-digest";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-digest-tools");

/**
 * Read the stored cross-account morning digest.
 *
 * Scoped to `email:read` rather than a new scope: `search_emails` already spans
 * every connected account under that scope, so this grants nothing a holder
 * could not already assemble.
 */
export async function getDailyDigestTool(
  context: McpToolContext,
  params: { date?: string },
) {
  logger.info("MCP tool: get_daily_digest", {
    userId: context.userId,
    clientId: context.clientId,
    date: params.date,
  });

  const emailAccount = await prisma.emailAccount.findFirst({
    where: { userId: context.userId },
    select: { timezone: true },
    orderBy: { createdAt: "asc" },
  });

  const timeZone = emailAccount?.timezone || "UTC";
  const date = params.date || getLocalDate(timeZone);

  const digest = await getDailyDigest({ userId: context.userId, date });

  if (!digest) {
    return {
      date,
      timeZone,
      available: false,
      message: `No digest stored for ${date}. Digests are generated each morning and kept for two days.`,
    };
  }

  return {
    date: digest.date,
    timeZone,
    available: true,
    generatedAt: digest.generatedAt,
    accounts: digest.accounts.map(
      (account: DailyDigest["accounts"][number]) => ({
        email: account.email,
        digest: account.text,
      }),
    ),
    unavailableAccounts: digest.failures.map(
      (failure: DailyDigest["failures"][number]) => failure.email,
    ),
  };
}
