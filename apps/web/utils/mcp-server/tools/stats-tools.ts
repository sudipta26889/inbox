import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { getStatsByPeriod } from "@/app/api/user/stats/by-period/controller";

const logger = createScopedLogger("mcp-stats-tools");

/**
 * Get email statistics for a time period
 */
export async function getEmailStats(
  context: McpToolContext,
  params: { period: "day" | "week" | "month" | "year"; fromDate?: string; toDate?: string }
) {
  logger.info("MCP tool: get_email_stats", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    period: params.period,
  });

  // Use existing stats controller
  const stats = await getStatsByPeriod({
    emailAccountId: context.emailAccountId,
    period: params.period,
    fromDate: params.fromDate,
    toDate: params.toDate,
  });

  return {
    period: params.period,
    stats: stats.map((stat) => ({
      date: stat.startOfPeriod,
      total: stat.totalCount,
      inbox: stat.inboxCount,
      notInbox: stat.notInbox,
      read: stat.readCount,
      sent: stat.sentCount,
      unread: stat.unread,
    })),
    summary: {
      totalEmails: stats.reduce((sum, stat) => sum + Number(stat.totalCount), 0),
      totalInbox: stats.reduce((sum, stat) => sum + Number(stat.inboxCount), 0),
      totalSent: stats.reduce((sum, stat) => sum + Number(stat.sentCount), 0),
      totalRead: stats.reduce((sum, stat) => sum + Number(stat.readCount), 0),
      totalUnread: stats.reduce((sum, stat) => sum + Number(stat.unread), 0),
    },
  };
}
