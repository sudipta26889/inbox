import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { getStatsByPeriod } from "@/app/api/user/stats/by-period/controller";

const logger = createScopedLogger("mcp-stats-tools");

/**
 * Get email statistics for a time period
 */
export async function getEmailStats(
  context: McpToolContext,
  params: {
    period: "day" | "week" | "month" | "year";
    fromDate?: string;
    toDate?: string;
  },
) {
  logger.info("MCP tool: get_email_stats", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    period: params.period,
  });

  // The controller takes epoch milliseconds (z.coerce.number()), not the ISO
  // strings this tool accepts — passing them straight through produced NaN
  // date bounds.
  const statsData = await getStatsByPeriod({
    emailAccountId: context.emailAccountId,
    period: params.period,
    fromDate: toEpochMs(params.fromDate),
    toDate: toEpochMs(params.toDate),
  });

  return {
    period: params.period,
    stats: statsData.result.map((stat) => ({
      date: stat.startOfPeriod,
      total: stat.All,
      inbox: stat.Unarchived,
      sent: stat.Sent,
      read: stat.Read,
      unread: stat.Unread,
    })),
    summary: {
      totalEmails: statsData.allCount,
      totalInbox: statsData.inboxCount,
      totalSent: statsData.sentCount,
      totalRead: statsData.readCount,
      totalUnread: statsData.allCount - statsData.readCount,
    },
  };
}

/** Accepts an ISO date string; returns epoch ms, or null when absent/invalid. */
function toEpochMs(value: string | undefined): number | null {
  if (!value) return null;

  const parsed = new Date(value).getTime();

  return Number.isNaN(parsed) ? null : parsed;
}
