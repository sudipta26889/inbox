import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { reindexTask } from "@/utils/taskpilot/reindex";

const logger = createScopedLogger("taskpilot-reindex-all");

async function main() {
  // Distinct (emailAccountId, projectId, taskpilotIssueId) — multiple link rows
  // can point at the same task (multi-target comments produce one row per
  // target per message, plus the original creation row).
  const links = await prisma.emailTaskLink.findMany({
    distinct: ["emailAccountId", "taskpilotIssueId"],
    select: {
      emailAccountId: true,
      projectId: true,
      taskpilotIssueId: true,
      taskpilotIdentifier: true,
      workspaceSlug: true,
      emailAccount: { select: { userId: true } },
    },
  });

  logger.info("starting backfill", { total: links.length });

  const clientCache = new Map<string, TaskpilotClient>();
  let done = 0;
  for (const link of links) {
    const userId = link.emailAccount.userId;
    if (!clientCache.has(userId)) {
      const config = await getTaskpilotConfigForUser(userId);
      clientCache.set(userId, new TaskpilotClient(config));
    }
    const client = clientCache.get(userId)!;
    await reindexTask(client, link.emailAccountId, {
      projectId: link.projectId,
      taskpilotIssueId: link.taskpilotIssueId,
      taskpilotIdentifier: link.taskpilotIdentifier,
      workspaceSlug: link.workspaceSlug,
    });
    done += 1;
    if (done % 50 === 0) {
      logger.info("backfill progress", { done, total: links.length });
    }
  }
  logger.info("backfill complete", { done });
}

main().catch((err) => {
  logger.error("backfill failed", { err });
  process.exit(1);
});
