import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { sleep } from "@/utils/sleep";
import { getEmailUrlForMessage } from "@/utils/url";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { errorStatus, TaskpilotNotFoundError } from "@/utils/taskpilot/errors";
import { buildInboxThreadLinkInput } from "@/utils/taskpilot/inbox-link";
import type { TaskDetail } from "@/utils/taskpilot/types";

// Bounds the whole backfill; EmailTaskLink has 3 rows (2 items) in production.
export const LINK_BACKFILL_MAX_TOTAL = 50;
export const LINK_BACKFILL_MAX_PER_RUN = 20;
export const LINK_BACKFILL_DELAY_MS = 1000;

const DONE_KEY = "taskpilot:link-backfill:done";
const SAMPLE_SIZE = 3;
const PENDING_IDENTIFIER = "(pending)";

export type LinkBackfillResult = {
  /** Work items looked at this run (not rows). */
  checked: number;
  added: number;
  skipped: number;
  /** Items TaskPilot no longer has. */
  missing: number;
  failed: number;
  failedByStatus: Record<string, number>;
  sample: { issueId: string; identifier: string | null }[];
};

type BackfillRow = Awaited<ReturnType<typeof findRows>>[number];

/**
 * Adds the "Inbox thread" link to work items Inbox created before addLink
 * worked. It only adds that one link, only to items in EmailTaskLink, and only
 * when TaskPilot does not already hold the same url. An item is recorded as
 * done only once the link is seen on a re-read (or the item is gone), so
 * anything else is retried on the next run.
 */
export async function backfillTaskpilotLinks({
  logger,
  maxPerRun,
  maxTotal,
  delayMs,
}: {
  logger: Logger;
  maxPerRun: number;
  maxTotal: number;
  delayMs: number;
}): Promise<LinkBackfillResult> {
  const result: LinkBackfillResult = {
    checked: 0,
    added: 0,
    skipped: 0,
    missing: 0,
    failed: 0,
    failedByStatus: {},
    sample: [],
  };

  const done = new Set(await redis.smembers(DONE_KEY));
  if (done.size >= maxTotal) return finish(result, logger);

  const items = groupByWorkItem(await findRows(), done);
  const clients = new Map<string, WorkspaceAccess>();
  const projectIdentifiers = new Map<string, Promise<Map<string, string>>>();

  for (const rows of items) {
    if (done.size >= maxTotal || result.checked >= maxPerRun) break;

    if (result.checked > 0) await sleep(delayMs);
    result.checked++;

    const first = rows[0];
    const issueId = first.taskpilotIssueId;

    try {
      const { client, pin } = await getClient(clients, first);

      // Work in another project is outside the pin: left alone, and not
      // marked done, so lifting or changing the pin later picks it up.
      if (pin && first.projectId !== pin) {
        result.skipped++;
        continue;
      }

      let task: TaskDetail;
      try {
        task = await client.getTask(first.projectId, issueId);
      } catch (err) {
        if (!(err instanceof TaskpilotNotFoundError)) throw err;
        result.missing++;
        await markDone(done, rows);
        continue;
      }

      const identifier = await resolveIdentifier(
        task,
        first,
        client,
        projectIdentifiers,
      );
      await fixPendingIdentifier(rows, identifier, logger);

      const input = buildInboxThreadLinkInput({
        deepLink: getEmailUrlForMessage(
          first.gmailMessageId,
          first.threadId ?? "",
          first.emailAccount.email,
          first.emailAccount.account?.provider,
        ),
        threadId: first.threadId,
        emailAccountId: first.emailAccountId,
        messageId: first.gmailMessageId,
      });

      if (await hasLink(client, first, input.url)) {
        result.skipped++;
        await markDone(done, rows);
        continue;
      }

      await client.addLink(first.projectId, issueId, input);

      if (!(await hasLink(client, first, input.url))) {
        countFailure(result, "verify_missing");
        logger.error("Link backfill: link not visible after adding it", {
          issueId,
          identifier,
        });
        continue;
      }

      result.added++;
      if (result.sample.length < SAMPLE_SIZE) {
        result.sample.push({ issueId, identifier });
      }
      await markDone(done, rows);
    } catch (err) {
      const status = errorStatus(err);
      countFailure(result, status === undefined ? "unknown" : String(status));
      logger.error("Link backfill failed for a work item", {
        err,
        issueId,
        status,
      });
    }
  }

  return finish(result, logger);
}

function findRows() {
  return prisma.emailTaskLink.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      emailAccount: {
        select: {
          email: true,
          userId: true,
          account: { select: { provider: true } },
        },
      },
    },
  });
}

// One entry per work item, oldest first, holding every row that points at it.
// Items whose rows are all done are dropped; a partly done item keeps only the
// rows still open, so they get marked done together.
function groupByWorkItem(rows: BackfillRow[], done: Set<string>) {
  const items = new Map<string, BackfillRow[]>();
  for (const row of rows) {
    if (done.has(row.id)) continue;
    const key = `${row.projectId}:${row.taskpilotIssueId}`;
    items.set(key, [...(items.get(key) ?? []), row]);
  }
  return [...items.values()];
}

async function resolveIdentifier(
  task: TaskDetail,
  row: { projectId: string },
  client: TaskpilotClient,
  projectIdentifiers: Map<string, Promise<Map<string, string>>>,
): Promise<string | null> {
  if (task.identifier) return task.identifier;
  if (typeof task.sequence_id !== "number") return null;

  const key = row.projectId;
  if (!projectIdentifiers.has(key)) {
    projectIdentifiers.set(
      key,
      client
        .listProjects()
        .then((projects) => new Map(projects.map((p) => [p.id, p.identifier]))),
    );
  }
  const projectIdentifier = (await projectIdentifiers.get(key))?.get(
    row.projectId,
  );
  return projectIdentifier ? `${projectIdentifier}-${task.sequence_id}` : null;
}

// Inbox's own table: an item created before its identifier was known is stuck
// on "(pending)". A failure here must not stop the link being added.
async function fixPendingIdentifier(
  rows: BackfillRow[],
  identifier: string | null,
  logger: Logger,
) {
  if (!identifier) return;
  const pendingIds = rows
    .filter((row) => row.taskpilotIdentifier === PENDING_IDENTIFIER)
    .map((row) => row.id);
  if (pendingIds.length === 0) return;

  try {
    await prisma.emailTaskLink.updateMany({
      where: { id: { in: pendingIds } },
      data: { taskpilotIdentifier: identifier },
    });
  } catch (err) {
    logger.error("Link backfill could not update a pending identifier", {
      err,
      identifier,
    });
  }
}

async function hasLink(
  client: TaskpilotClient,
  row: { projectId: string; taskpilotIssueId: string },
  url: string,
) {
  const links = await client.listLinks(row.projectId, row.taskpilotIssueId);
  return links.some((link) => link.url === url);
}

type WorkspaceAccess = { client: TaskpilotClient; pin: string | null };

// Same way the create path gets its client, but on the row's own workspace.
async function getClient(
  clients: Map<string, WorkspaceAccess>,
  row: { emailAccount: { userId: string }; workspaceSlug: string },
): Promise<WorkspaceAccess> {
  const key = `${row.emailAccount.userId}:${row.workspaceSlug}`;
  const cached = clients.get(key);
  if (cached) return cached;

  const config = await getTaskpilotConfigForUser(row.emailAccount.userId);
  const access = {
    client: new TaskpilotClient({
      apiKey: config.apiKey,
      workspaceSlug: row.workspaceSlug,
    }),
    pin: config.projectId,
  };
  clients.set(key, access);
  return access;
}

async function markDone(done: Set<string>, rows: BackfillRow[]) {
  for (const row of rows) {
    await redis.sadd(DONE_KEY, row.id);
    done.add(row.id);
  }
}

function countFailure(result: LinkBackfillResult, reason: string) {
  result.failed++;
  result.failedByStatus[reason] = (result.failedByStatus[reason] ?? 0) + 1;
}

function finish(result: LinkBackfillResult, logger: Logger) {
  logger.info("TaskPilot link backfill finished", result);
  return result;
}
