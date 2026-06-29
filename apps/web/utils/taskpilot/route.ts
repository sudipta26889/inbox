import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import {
  getTaskpilotConfigForUser,
  getTaskpilotConfigStatus,
} from "@/utils/taskpilot/config";
import { decidePass1, decidePass2 } from "@/utils/taskpilot/decide";
import { hydrateCandidates } from "@/utils/taskpilot/hydrate";
import { reindexTask } from "@/utils/taskpilot/reindex";
import { commitTask } from "@/utils/taskpilot/service";
import { findSimilarTasksTopK } from "@/utils/taskpilot/similar";
import type { Pass1Decision } from "@/utils/taskpilot/schemas";
import type { CreateTaskDraft, RichCandidate } from "@/utils/taskpilot/types";
import { validatePass1Decision } from "@/utils/taskpilot/validate-decision";

const logger = createScopedLogger("taskpilot-route");

const MAX_CANDIDATES = 3;
const COMMENT_LIMIT_FOR_PASS1 = 5;
const SENTINEL_STALE_MS = 60_000;

export interface RouteInput {
  canCreate: boolean;
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
  threadId: string | null;
  userId: string;
}

export async function maybeRouteToTaskPilot(input: RouteInput): Promise<void> {
  let decisionRowId: string | null = null;
  try {
    // Step 0: bail if message is already linked (idempotency).
    const linkRow = await prisma.emailTaskLink.findFirst({
      where: {
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
      },
    });
    if (linkRow) {
      logger.trace("route: already linked, skipping", {
        messageId: input.messageId,
      });
      return;
    }

    // Step 0.5: bail if TaskPilot is not configured for this user.
    const status = await getTaskpilotConfigStatus(input.userId);
    if (!status.configured) return;

    // Step 1: pre-gate signals — thread link, semantic similarity, canCreate.
    const threadLinkRow = input.threadId
      ? await prisma.emailTaskLink.findFirst({
          where: {
            emailAccountId: input.emailAccountId,
            threadId: input.threadId,
          },
          orderBy: { createdAt: "desc" },
        })
      : null;

    const embedText = [
      input.email.subject,
      input.email.bodyText ?? input.email.snippet,
    ]
      .filter(Boolean)
      .join("\n");
    const similar = await findSimilarTasksTopK(
      input.emailAccountId,
      embedText,
      MAX_CANDIDATES,
      env.TASKPILOT_PREGATE_RECALL_THRESHOLD,
    );

    const preGateInvoke =
      Boolean(threadLinkRow) || similar.length > 0 || input.canCreate;
    const preGateSignals = {
      hasThreadLink: Boolean(threadLinkRow),
      similarCount: similar.length,
      topScore: similar[0]?.score ?? null,
      canCreate: input.canCreate,
    };

    if (!preGateInvoke) {
      await prisma.taskpilotDecision.create({
        data: {
          emailAccountId: input.emailAccountId,
          gmailMessageId: input.messageId,
          threadId: input.threadId,
          preGateInvoked: false,
          preGateSignals,
          candidateIssueIds: [],
          pass1Action: null,
          targetIssueIds: [],
          status: "IGNORED",
          errorMsg: null,
        },
      });
      return;
    }

    // Step 2: race sentinel — block concurrent workers for the same message.
    const inFlight = await prisma.taskpilotDecision.findFirst({
      where: {
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
        status: "RUNNING",
      },
      orderBy: { ranAt: "desc" },
    });
    if (
      inFlight &&
      Date.now() - new Date(inFlight.ranAt).getTime() < SENTINEL_STALE_MS
    ) {
      logger.warn("route: concurrent worker holding sentinel; bailing", {
        messageId: input.messageId,
      });
      return;
    }

    const decisionRow = await prisma.taskpilotDecision.create({
      data: {
        emailAccountId: input.emailAccountId,
        gmailMessageId: input.messageId,
        threadId: input.threadId,
        preGateInvoked: true,
        preGateSignals,
        candidateIssueIds: [],
        pass1Action: null,
        targetIssueIds: [],
        status: "RUNNING",
        errorMsg: null,
      },
    });
    decisionRowId = decisionRow.id;

    if (env.TASKPILOT_DECISIONS_SHADOW) {
      await runShadow(input, decisionRow.id, threadLinkRow, similar);
      return;
    }
    await runLive(input, decisionRow.id, threadLinkRow, similar);
  } catch (err) {
    logger.error("route: unexpected error", { err, decisionRowId });
    if (decisionRowId) {
      try {
        await prisma.taskpilotDecision.update({
          where: { id: decisionRowId },
          data: { status: "LLM_FAILED", errorMsg: (err as Error).message },
        });
      } catch (updateErr) {
        logger.error("route: failed to update audit row after error", {
          err: updateErr,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ThreadLinkRow = {
  taskpilotIssueId: string;
  taskpilotIdentifier: string;
  workspaceSlug: string;
  projectId: string;
} | null;

async function runLive(
  input: RouteInput,
  decisionId: string,
  threadLinkRow: ThreadLinkRow,
  similar: Awaited<ReturnType<typeof findSimilarTasksTopK>>,
): Promise<void> {
  const config = await getTaskpilotConfigForUser(input.userId);
  const client = new TaskpilotClient(config);

  // Step 3: hydrate candidates (thread-link + semantic hits).
  const candidates = await hydrateCandidates(
    client,
    similar,
    threadLinkRow
      ? {
          projectId: threadLinkRow.projectId,
          taskpilotIssueId: threadLinkRow.taskpilotIssueId,
          taskpilotIdentifier: threadLinkRow.taskpilotIdentifier,
          workspaceSlug: threadLinkRow.workspaceSlug,
        }
      : null,
    { maxCandidates: MAX_CANDIDATES, commentLimit: COMMENT_LIMIT_FOR_PASS1 },
  );

  const projects = input.canCreate
    ? await taskpilotCache.getProjects(input.userId, () =>
        client.listProjects(),
      )
    : [];
  const labelsByProject: Record<
    string,
    Array<{ id: string; name: string }>
  > = {};
  if (input.canCreate) {
    for (const p of projects) {
      labelsByProject[p.id] = await taskpilotCache.getLabels(
        input.userId,
        p.id,
        () => client.listLabels(p.id),
      );
    }
  }

  // Step 4: Pass 1 LLM decision.
  const pass1 = await decidePass1({
    mode: "auto",
    email: {
      from: input.email.from,
      subject: input.email.subject,
      bodyText: input.email.bodyText ?? input.email.snippet,
      receivedAt: input.email.receivedAt,
    },
    candidates,
    canCreate: input.canCreate,
    projects,
    labelsByProject,
    todayISO: new Date().toISOString().slice(0, 10),
    model: env.TASKPILOT_DECIDER_MODEL,
    effort: env.TASKPILOT_DECIDER_REASONING_EFFORT,
    maxTokens: env.TASKPILOT_DECIDER_MAX_TOKENS,
    timeoutMs: env.TASKPILOT_DECIDER_TIMEOUT_MS,
  });

  await prisma.taskpilotDecision.update({
    where: { id: decisionId },
    data: {
      candidateIssueIds: candidates.map((c) => c.taskpilotIssueId),
      pass1Model: pass1.model,
      pass1Effort: pass1.effort,
      pass1DurationMs: pass1.durationMs,
      pass1InputTokens: pass1.usage?.input ?? null,
      pass1OutputTokens: pass1.usage?.output ?? null,
    },
  });

  if (!pass1.ok) {
    await prisma.taskpilotDecision.update({
      where: { id: decisionId },
      data: { status: "LLM_FAILED", errorMsg: pass1.errorMsg },
    });
    return;
  }

  // Step 5: code-side validation of Pass 1 decision.
  const ctx = {
    canCreate: input.canCreate,
    candidateIssueIds: new Set(candidates.map((c) => c.taskpilotIssueId)),
    projectIds: new Set(projects.map((p) => p.id)),
    projectLabels: new Map(
      Object.entries(labelsByProject).map(([k, v]) => [
        k,
        new Set(v.map((l) => l.name)),
      ]),
    ),
  };
  const validation = validatePass1Decision(pass1.decision, ctx);
  if (validation.kind === "downgrade") {
    await prisma.taskpilotDecision.update({
      where: { id: decisionId },
      data: {
        pass1Action: "DOWNGRADED",
        pass1Decision: pass1.decision as object,
        pass1Reason: pass1.decision.reason,
        status: "DOWNGRADED",
        errorMsg: validation.reason,
      },
    });
    return;
  }

  const decision = validation.decision;
  await prisma.taskpilotDecision.update({
    where: { id: decisionId },
    data: {
      pass1Action: decision.action,
      pass1Decision: decision as object,
      pass1Reason: decision.reason,
    },
  });

  // Step 6: execute per action.
  if (decision.action === "IGNORE") {
    await prisma.taskpilotDecision.update({
      where: { id: decisionId },
      data: { status: "IGNORED" },
    });
    return;
  }

  if (decision.action === "CREATE") {
    await executeCreate(input, client, decision, decisionId);
    return;
  }

  // COMMENT_ON
  await executeCommentOn(input, client, decision, candidates, decisionId);
}

async function runShadow(
  input: RouteInput,
  decisionId: string,
  threadLinkRow: ThreadLinkRow,
  similar: Awaited<ReturnType<typeof findSimilarTasksTopK>>,
): Promise<void> {
  // Shadow mode: run Pass 1 to populate audit row, skip all TaskPilot mutations.
  const config = await getTaskpilotConfigForUser(input.userId);
  const client = new TaskpilotClient(config);
  const candidates = await hydrateCandidates(
    client,
    similar,
    threadLinkRow
      ? {
          projectId: threadLinkRow.projectId,
          taskpilotIssueId: threadLinkRow.taskpilotIssueId,
          taskpilotIdentifier: threadLinkRow.taskpilotIdentifier,
          workspaceSlug: threadLinkRow.workspaceSlug,
        }
      : null,
    { maxCandidates: MAX_CANDIDATES, commentLimit: COMMENT_LIMIT_FOR_PASS1 },
  );

  const pass1 = await decidePass1({
    mode: "auto",
    email: {
      from: input.email.from,
      subject: input.email.subject,
      bodyText: input.email.bodyText ?? input.email.snippet,
      receivedAt: input.email.receivedAt,
    },
    candidates,
    canCreate: input.canCreate,
    projects: [],
    labelsByProject: {},
    todayISO: new Date().toISOString().slice(0, 10),
    model: env.TASKPILOT_DECIDER_MODEL,
    effort: env.TASKPILOT_DECIDER_REASONING_EFFORT,
    maxTokens: env.TASKPILOT_DECIDER_MAX_TOKENS,
    timeoutMs: env.TASKPILOT_DECIDER_TIMEOUT_MS,
  });

  await prisma.taskpilotDecision.update({
    where: { id: decisionId },
    data: {
      candidateIssueIds: candidates.map((c) => c.taskpilotIssueId),
      pass1Model: pass1.model,
      pass1Effort: pass1.effort,
      pass1DurationMs: pass1.durationMs,
      pass1InputTokens: pass1.usage?.input ?? null,
      pass1OutputTokens: pass1.usage?.output ?? null,
      pass1Action: pass1.ok ? pass1.decision.action : null,
      pass1Decision: pass1.ok ? (pass1.decision as object) : null,
      pass1Reason: pass1.ok ? pass1.decision.reason : null,
      status: pass1.ok ? "SHADOW" : "LLM_FAILED",
      errorMsg: pass1.ok ? null : pass1.errorMsg,
    },
  });
}

async function executeCreate(
  input: RouteInput,
  _client: TaskpilotClient,
  decision: Extract<Pass1Decision, { action: "CREATE" }>,
  decisionId: string,
): Promise<void> {
  try {
    const draft: CreateTaskDraft = {
      projectId: decision.draft.projectId,
      title: decision.draft.title,
      description_html: decision.draft.descriptionHtml,
      priority: decision.draft.priority,
      labelNames: decision.draft.labelNames,
      targetDate: decision.draft.targetDate ?? undefined,
    };
    const result = await commitTask({
      userId: input.userId,
      emailAccountId: input.emailAccountId,
      messageId: input.messageId,
      threadId: input.threadId,
      deepLink: input.deepLink,
      source: "RULE",
      ruleId: null,
      draft,
    });
    await prisma.taskpilotDecision.update({
      where: { id: decisionId },
      data: {
        targetIssueIds: [result.taskpilotIssueId],
        commentsPosted: 0,
        status: "SUCCESS",
      },
    });
  } catch (err) {
    await prisma.taskpilotDecision.update({
      where: { id: decisionId },
      data: {
        status: "TASKPILOT_FAILED",
        errorMsg: (err as Error).message,
      },
    });
  }
}

async function executeCommentOn(
  input: RouteInput,
  client: TaskpilotClient,
  decision: Extract<Pass1Decision, { action: "COMMENT_ON" }>,
  candidates: RichCandidate[],
  decisionId: string,
): Promise<void> {
  let posted = 0;
  let stateMoves = 0;
  const failures: string[] = [];

  const commentHtml = buildCommentHtml(decision.comment, input.deepLink);

  for (const targetId of decision.targetIssueIds) {
    const cand = candidates.find((c) => c.taskpilotIssueId === targetId);
    if (!cand) continue;
    try {
      // Per-target idempotency.
      const existing = await prisma.emailTaskLink.findFirst({
        where: {
          emailAccountId: input.emailAccountId,
          gmailMessageId: input.messageId,
          taskpilotIssueId: targetId,
        },
      });
      if (existing) continue;

      await client.addComment(cand.projectId, targetId, commentHtml);
      posted += 1;

      if (decision.stateGroup) {
        try {
          const states = await taskpilotCache.getStates(
            input.userId,
            cand.projectId,
            () => client.listStates(cand.projectId),
          );
          const targetState = states.find(
            (s) => s.group === decision.stateGroup,
          );
          if (targetState) {
            await client.moveTask(cand.projectId, targetId, targetState.id);
            stateMoves += 1;
          }
        } catch (stateErr) {
          logger.warn("route: state move failed; keeping comment", {
            targetId,
            err: stateErr,
          });
        }
      }

      await prisma.emailTaskLink.upsert({
        where: {
          emailAccountId_gmailMessageId_taskpilotIssueId: {
            emailAccountId: input.emailAccountId,
            gmailMessageId: input.messageId,
            taskpilotIssueId: targetId,
          },
        },
        create: {
          emailAccountId: input.emailAccountId,
          gmailMessageId: input.messageId,
          threadId: input.threadId,
          workspaceSlug: cand.workspaceSlug,
          projectId: cand.projectId,
          taskpilotIssueId: targetId,
          taskpilotIdentifier: cand.taskpilotIdentifier,
          source: "RULE",
          ruleId: null,
        },
        update: {},
      });

      // ponytail: fire-and-forget; failure here is non-fatal
      reindexTask(client, input.emailAccountId, {
        projectId: cand.projectId,
        taskpilotIssueId: targetId,
        taskpilotIdentifier: cand.taskpilotIdentifier,
        workspaceSlug: cand.workspaceSlug,
      }).catch(() => undefined);
    } catch (err) {
      failures.push(`${targetId}: ${(err as Error).message}`);
      logger.warn("route: per-target comment failed", { targetId, err });
    }
  }

  const status =
    posted === 0
      ? "TASKPILOT_FAILED"
      : failures.length === 0
        ? "SUCCESS"
        : "PARTIAL";

  await prisma.taskpilotDecision.update({
    where: { id: decisionId },
    data: {
      targetIssueIds: decision.targetIssueIds,
      commentsPosted: posted,
      stateMovesApplied: stateMoves,
      status,
      errorMsg: failures.length ? failures.join("; ") : null,
    },
  });

  if (posted > 0 && decision.fieldUpdatesNeeded) {
    await applyPass2(
      input,
      client,
      decision.targetIssueIds.filter((id) =>
        candidates.some((c) => c.taskpilotIssueId === id),
      ),
      candidates,
      decisionId,
    );
  }
}

async function applyPass2(
  input: RouteInput,
  client: TaskpilotClient,
  executedIds: string[],
  candidates: RichCandidate[],
  decisionId: string,
): Promise<void> {
  const executedTargets = candidates.filter((c) =>
    executedIds.includes(c.taskpilotIssueId),
  );

  const projectLabels: Record<string, string[]> = {};
  for (const t of executedTargets) {
    if (projectLabels[t.projectId]) continue;
    const labels = await taskpilotCache.getLabels(
      input.userId,
      t.projectId,
      () => client.listLabels(t.projectId),
    );
    projectLabels[t.projectId] = labels.map((l) => l.name);
  }
  const members = await taskpilotCache.getMembers(input.userId, () =>
    client.listMembers(),
  );

  const pass2 = await decidePass2({
    email: {
      from: input.email.from,
      subject: input.email.subject,
      bodyText: input.email.bodyText ?? input.email.snippet,
    },
    executedTargets,
    projectLabels,
    workspaceMembers: members.map((m) => m.email),
    todayISO: new Date().toISOString().slice(0, 10),
    model: env.TASKPILOT_FIELDS_MODEL,
    effort: env.TASKPILOT_FIELDS_REASONING_EFFORT,
    maxTokens: env.TASKPILOT_FIELDS_MAX_TOKENS,
    timeoutMs: env.TASKPILOT_DECIDER_TIMEOUT_MS,
  });

  let applied = 0;
  if (pass2.ok) {
    for (const u of pass2.updates.updates) {
      if (!executedIds.includes(u.targetIssueId)) continue;
      const target = executedTargets.find(
        (t) => t.taskpilotIssueId === u.targetIssueId,
      );
      if (!target) continue;

      const allowedLabels = new Set(projectLabels[target.projectId] ?? []);
      const memberSet = new Set(members.map((m) => m.email));

      const patch: Record<string, unknown> = {};
      if (u.priority) patch.priority = u.priority;
      if (u.targetDate) patch.target_date = u.targetDate;
      if (u.assigneeEmail && memberSet.has(u.assigneeEmail)) {
        const member = members.find((m) => m.email === u.assigneeEmail);
        if (member) patch.assignee_ids = [member.id];
      }

      const labelAdds = u.addLabelNames.filter((n) => allowedLabels.has(n));
      const labelRemoves = u.removeLabelNames;
      if (labelAdds.length || labelRemoves.length) {
        const labelsForProject = await taskpilotCache.getLabels(
          input.userId,
          target.projectId,
          () => client.listLabels(target.projectId),
        );
        const labelIdsByName = new Map(
          labelsForProject.map((l) => [l.name, l.id]),
        );
        const existingLabelIds = new Set(target.detail.labels.map((l) => l.id));
        for (const name of labelRemoves) {
          const id = labelIdsByName.get(name);
          if (id) existingLabelIds.delete(id);
        }
        for (const name of labelAdds) {
          const id = labelIdsByName.get(name);
          if (id) existingLabelIds.add(id);
        }
        patch.label_ids = [...existingLabelIds];
      }

      if (Object.keys(patch).length === 0) continue;
      try {
        await client.updateTask(target.projectId, u.targetIssueId, patch);
        applied += 1;
      } catch (err) {
        logger.warn("route: pass2 updateTask failed", {
          err,
          targetId: u.targetIssueId,
        });
      }
    }
  }

  await prisma.taskpilotDecision.update({
    where: { id: decisionId },
    data: {
      pass2Ran: true,
      pass2Model: pass2.model,
      pass2DurationMs: pass2.durationMs,
      pass2InputTokens: pass2.usage?.input ?? null,
      pass2OutputTokens: pass2.usage?.output ?? null,
      pass2Updates: pass2.ok ? (pass2.updates as object) : null,
      fieldUpdatesApplied: applied,
    },
  });
}

function buildCommentHtml(
  comment: { summary: string; highlights: string[] },
  deepLink: string,
): string {
  const safe = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const bulletsHtml = comment.highlights.length
    ? `<ul>${comment.highlights.map((h) => `<li>${safe(h)}</li>`).join("")}</ul>`
    : "";
  return (
    `<p>${safe(comment.summary)}</p>` +
    bulletsHtml +
    `<p><a href="${safe(deepLink)}">View in Inbox</a></p>`
  );
}
