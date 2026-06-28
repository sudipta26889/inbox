import type { EmailTaskLinkSource } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  enrichEmailIntoTask,
  INBOX_LINK_PLACEHOLDER,
} from "@/utils/ai/taskpilot/enrich";
import type {
  EnrichedTaskDraft,
  EnrichmentEmail,
  EnrichmentInput,
} from "@/utils/ai/taskpilot/enrich";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { findSimilarTask, indexTask } from "@/utils/taskpilot/similar";
import type { Label, Project } from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-service");

export interface DraftInput {
  /** Required for production; injected by callers that have an emailAccount in scope. */
  chatCompletionObject?: EnrichmentInput["chatCompletionObject"];
  email: EnrichmentEmail;
  emailAccountId: string;
  messageId: string;
  ruleContext?: string;
  userId: string;
}

export interface DraftResult {
  alreadyExisted: boolean;
  draft?: EnrichedTaskDraft;
  labelsByProject?: Record<string, Label[]>;
  link?: {
    taskpilotIdentifier: string;
    taskpilotIssueId: string;
    projectId: string;
  };
  projects?: Project[];
}

export async function draftTaskFromEmail(
  input: DraftInput,
): Promise<DraftResult> {
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
      alreadyExisted: true,
      link: {
        taskpilotIdentifier: existing.taskpilotIdentifier,
        taskpilotIssueId: existing.taskpilotIssueId,
        projectId: existing.projectId,
      },
    };
  }

  const config = await getTaskpilotConfigForUser(input.userId);
  const client = new TaskpilotClient(config);
  const projects = await taskpilotCache.getProjects(input.userId, () =>
    client.listProjects(),
  );
  const labelsByProject = new Map<string, Label[]>();
  for (const p of projects) {
    const labels = await taskpilotCache.getLabels(input.userId, p.id, () =>
      client.listLabels(p.id),
    );
    labelsByProject.set(p.id, labels);
  }

  const draft = await enrichEmailIntoTask({
    email: input.email,
    projects,
    labelsByProject,
    ruleContext: input.ruleContext,
    chatCompletionObject: input.chatCompletionObject,
  });

  return {
    alreadyExisted: false,
    draft,
    projects,
    labelsByProject: Object.fromEntries(labelsByProject),
  };
}

export interface CommitInput {
  deepLink: string;
  draft: EnrichedTaskDraft;
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
    // Fire-and-forget. indexTask catches its own errors.
    indexTask({
      emailAccountId: input.emailAccountId,
      taskpilotIssueId: created.id,
      taskpilotIdentifier: link.taskpilotIdentifier,
      workspaceSlug,
      projectId: input.draft.projectId,
      text: `${input.draft.title}\n\n${input.draft.description_html}`,
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

export interface CommentInput {
  deepLink: string;
  email: {
    subject: string;
    from: string;
    snippet: string;
    bodyText?: string;
    receivedAt: Date;
  };
  emailAccountId: string;
  messageId: string;
  ruleId?: string | null;
  source: EmailTaskLinkSource;
  threadId: string | null;
  userId: string;
}

interface ExistingTaskTarget {
  projectId: string;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  workspaceSlug: string;
}

/**
 * Comment on the task linked to this thread and record a link row for the new
 * message (so badges show on both messages). Returns null when the linked task
 * no longer exists in TaskPilot — caller should fall through to commitTask.
 */
export async function commentOnLinkedTask(
  input: CommentInput,
): Promise<CommitResult | null> {
  if (!input.threadId) return null;
  const existing = await findLinkByThread(input.emailAccountId, input.threadId);
  if (!existing) return null;
  return applyCommentAndLink(input, {
    taskpilotIssueId: existing.taskpilotIssueId,
    taskpilotIdentifier: existing.taskpilotIdentifier,
    workspaceSlug: existing.workspaceSlug,
    projectId: existing.projectId,
  });
}

/**
 * Cross-thread semantic dedupe via qdrant. Returns null when there is no
 * sufficiently similar open task (or qdrant is unreachable) — caller falls
 * through to commitTask.
 */
export async function commentOnSimilarTask(
  input: CommentInput,
): Promise<CommitResult | null> {
  const text = [
    input.email.subject,
    input.email.from,
    input.email.bodyText ?? input.email.snippet,
  ]
    .filter(Boolean)
    .join("\n");
  const hit = await findSimilarTask(input.emailAccountId, text);
  if (!hit) return null;
  logger.info("semantic-dedupe hit", {
    issueId: hit.taskpilotIssueId,
    score: hit.score,
  });
  return applyCommentAndLink(input, {
    taskpilotIssueId: hit.taskpilotIssueId,
    taskpilotIdentifier: hit.taskpilotIdentifier,
    workspaceSlug: hit.workspaceSlug,
    projectId: hit.projectId,
  });
}

async function applyCommentAndLink(
  input: CommentInput,
  target: ExistingTaskTarget,
): Promise<CommitResult | null> {
  const config = await getTaskpilotConfigForUser(input.userId);
  const client = new TaskpilotClient(config);
  const html = buildCommentHtml(input);

  try {
    await client.addComment(target.projectId, target.taskpilotIssueId, html);
  } catch (err) {
    // 404 = task was deleted in TaskPilot; signal caller to create instead.
    if (
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code: string }).code === "TASKPILOT_NOT_FOUND"
    ) {
      logger.warn("target task gone in TaskPilot, will create", {
        issueId: target.taskpilotIssueId,
      });
      return null;
    }
    throw err;
  }

  await prisma.emailTaskLink.upsert({
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
      workspaceSlug: target.workspaceSlug,
      projectId: target.projectId,
      taskpilotIssueId: target.taskpilotIssueId,
      taskpilotIdentifier: target.taskpilotIdentifier,
      source: input.source,
      ruleId: input.ruleId ?? null,
    },
    update: {},
  });

  return {
    taskpilotIdentifier: target.taskpilotIdentifier,
    taskpilotIssueId: target.taskpilotIssueId,
    taskpilotUrl: buildTaskpilotUrl(
      target.workspaceSlug,
      target.taskpilotIdentifier,
    ),
    alreadyExisted: true,
  };
}

function buildCommentHtml(input: CommentInput): string {
  const when = input.email.receivedAt.toISOString();
  const safeFrom = escapeHtml(input.email.from);
  const safeSubject = escapeHtml(input.email.subject);
  const safeSnippet = escapeHtml(input.email.snippet);
  return (
    "<p><strong>New message in this thread</strong></p>" +
    `<p>From: ${safeFrom}<br/>` +
    `Subject: ${safeSubject}<br/>` +
    `Received: ${when}</p>` +
    `<p>${safeSnippet}</p>` +
    `<p><a href="${input.deepLink}">Open in Inbox</a></p>`
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
