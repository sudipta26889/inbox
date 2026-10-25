import { getDailyDigest, getLocalDate } from "@/utils/a2a/daily-digest";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { getCallerUserId } from "@/utils/mcp-server/tool-context";
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
    where: { userId: getCallerUserId(context) },
    select: { timezone: true },
    orderBy: { createdAt: "asc" },
  });

  const timeZone = emailAccount?.timezone || "UTC";
  const date = params.date || getLocalDate(timeZone);

  const digest = await getDailyDigest({
    userId: getCallerUserId(context),
    date,
  });

  // Digests stored before the consolidated report have no text.
  if (!digest?.text) {
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
    since: digest.since,
    report: digest.text,
    accounts: digest.accounts.map((account) => account.email),
    unavailableAccounts: digest.failures.map((failure) => failure.email),
  };
}
