import type { EmailTaskLinkSource } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { reindexTask } from "@/utils/taskpilot/reindex";
import type { CreateTaskDraft } from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-service");

// ponytail: inline constant — enrich.ts deleted in Task 21
const INBOX_LINK_PLACEHOLDER = "{{INBOX_LINK}}";

export interface CommitInput {
  deepLink: string;
  draft: CreateTaskDraft;
  emailAccountId: string;
  messageId: string;
  ruleId?: string | null;
  source: EmailTaskLinkSource;
  threadId: string | null;
  userId: string;
}

export interface CommitResult {
  alreadyExisted: boolean;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  taskpilotUrl: string;
}

export async function commitTask(input: CommitInput): Promise<CommitResult> {
  const existing = await prisma.emailTaskLink.findUnique({
    where: {
      emailAccountId_gmailMessageId: {
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
      },
    },
  });
  if (existing) {
    return {
      taskpilotIdentifier: existing.taskpilotIdentifier,
      taskpilotIssueId: existing.taskpilotIssueId,
      taskpilotUrl: buildTaskpilotUrl(
        existing.workspaceSlug,
        existing.taskpilotIdentifier,
      ),
      alreadyExisted: true,
    };
  }

  const config = await getTaskpilotConfigForUser(input.userId);
  const client = new TaskpilotClient(config);
  const { workspaceSlug } = config;

  const descriptionHtml = input.draft.description_html
    .split(INBOX_LINK_PLACEHOLDER)
    .join(input.deepLink);

  const labels = await taskpilotCache.getLabels(
    input.userId,
    input.draft.projectId,
    () => client.listLabels(input.draft.projectId),
  );
  const nameToId = new Map(labels.map((l) => [l.name, l.id] as const));
  const labelIds = input.draft.labelNames
    .map((n) => nameToId.get(n))
    .filter((id): id is string => Boolean(id));

  const created = await client.createWorkItem(input.draft.projectId, {
    name: input.draft.title,
    description_html: descriptionHtml,
    priority: input.draft.priority,
    labels: labelIds.length ? labelIds : undefined,
    target_date: input.draft.targetDate,
    external_source: "inbox",
    external_id: input.messageId,
  });

  try {
    await client.addLink(created.id, {
      title: "Inbox thread",
      url: input.deepLink,
      metadata: {
        threadId: input.threadId,
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
      },
    });
  } catch (err) {
    logger.warn("addLink failed; continuing", { err, issueId: created.id });
  }

  const link = await prisma.emailTaskLink.upsert({
    where: {
      emailAccountId_gmailMessageId: {
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
      },
    },
    create: {
      emailAccountId: input.emailAccountId,
      gmailMessageId: input.messageId,
      threadId: input.threadId,
      workspaceSlug,
      projectId: input.draft.projectId,
      taskpilotIssueId: created.id,
      taskpilotIdentifier: created.identifier || "(pending)",
      source: input.source,
      ruleId: input.ruleId ?? null,
    },
    update: {
      taskpilotIssueId: created.id,
      taskpilotIdentifier: created.identifier || "(pending)",
    },
  });

  // Best-effort: index for cross-thread semantic dedupe on future emails.
  // Failure here is non-fatal — the task is already created and linked.
  if (!created.alreadyExisted) {
    reindexTask(client, input.emailAccountId, {
      projectId: input.draft.projectId,
      taskpilotIssueId: created.id,
      taskpilotIdentifier: link.taskpilotIdentifier,
      workspaceSlug,
    }).catch(() => undefined);
  }

  return {
    taskpilotIdentifier: link.taskpilotIdentifier,
    taskpilotIssueId: link.taskpilotIssueId,
    taskpilotUrl: buildTaskpilotUrl(workspaceSlug, link.taskpilotIdentifier),
    alreadyExisted: created.alreadyExisted,
  };
}

export async function getEmailTaskLink(
  emailAccountId: string,
  messageId: string,
): Promise<{
  identifier: string;
  url: string;
  workspaceSlug: string;
} | null> {
  const link = await prisma.emailTaskLink.findUnique({
    where: {
      emailAccountId_gmailMessageId: {
        emailAccountId,
        gmailMessageId: messageId,
      },
    },
  });
  if (!link) return null;
  return {
    identifier: link.taskpilotIdentifier,
    url: buildTaskpilotUrl(link.workspaceSlug, link.taskpilotIdentifier),
    workspaceSlug: link.workspaceSlug,
  };
}

function buildTaskpilotUrl(workspaceSlug: string, identifier: string): string {
  return `https://taskpilot.sudiptadhara.in/${workspaceSlug}/browse/${identifier}`;
}

export async function findLinkByThread(
  emailAccountId: string,
  threadId: string,
) {
  return prisma.emailTaskLink.findFirst({
    where: { emailAccountId, threadId },
    orderBy: { createdAt: "desc" },
  });
}
