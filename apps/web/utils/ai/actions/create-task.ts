import { createScopedLogger } from "@/utils/logger";
import type { EnrichmentInput } from "@/utils/ai/taskpilot/enrich";
import {
  commentOnLinkedTask,
  commitTask,
  draftTaskFromEmail,
} from "@/utils/taskpilot/service";

const logger = createScopedLogger("taskpilot-create-task-action");

export interface CreateTaskActionInput {
  /** Required in production; built from emailAccount by the caller. */
  chatCompletionObject: NonNullable<EnrichmentInput["chatCompletionObject"]>;
  email: {
    id: string;
    threadId: string | null;
    subject: string;
    from: string;
    snippet: string;
    bodyText: string;
    internalDate: string;
    deepLink: string;
  };
  emailAccountId: string;
  rule: { id: string; instructions: string | null } | null;
  userId: string;
}

export interface CreateTaskActionResult {
  alreadyExisted: boolean;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
}

export async function executeCreateTaskAction(
  input: CreateTaskActionInput,
): Promise<CreateTaskActionResult> {
  // Same thread already has a linked task? Comment on it instead of duplicating.
  // Skips the enrichment LLM call entirely on the comment path.
  if (input.email.threadId) {
    const commented = await commentOnLinkedTask({
      userId: input.userId,
      emailAccountId: input.emailAccountId,
      messageId: input.email.id,
      threadId: input.email.threadId,
      deepLink: input.email.deepLink,
      email: {
        subject: input.email.subject,
        from: input.email.from,
        snippet: input.email.snippet,
        receivedAt: new Date(Number(input.email.internalDate) || Date.now()),
      },
      source: "RULE",
      ruleId: input.rule?.id ?? null,
    });
    if (commented) {
      return {
        taskpilotIdentifier: commented.taskpilotIdentifier,
        taskpilotIssueId: commented.taskpilotIssueId,
        alreadyExisted: true,
      };
    }
  }

  const draftResult = await draftTaskFromEmail({
    userId: input.userId,
    emailAccountId: input.emailAccountId,
    messageId: input.email.id,
    email: {
      subject: input.email.subject,
      from: input.email.from,
      snippet: input.email.snippet,
      bodyText: input.email.bodyText,
      receivedAt: new Date(Number(input.email.internalDate) || Date.now()),
    },
    ruleContext: input.rule?.instructions ?? undefined,
    chatCompletionObject: input.chatCompletionObject,
  });

  if (draftResult.alreadyExisted && draftResult.link) {
    return {
      taskpilotIdentifier: draftResult.link.taskpilotIdentifier,
      taskpilotIssueId: draftResult.link.taskpilotIssueId,
      alreadyExisted: true,
    };
  }
  if (!draftResult.draft) {
    logger.error("draft missing without alreadyExisted; cannot proceed");
    throw new Error("taskpilot: draft missing in non-existing branch");
  }

  const commit = await commitTask({
    userId: input.userId,
    emailAccountId: input.emailAccountId,
    messageId: input.email.id,
    threadId: input.email.threadId,
    deepLink: input.email.deepLink,
    draft: draftResult.draft,
    source: "RULE",
    ruleId: input.rule?.id ?? null,
  });

  return {
    taskpilotIdentifier: commit.taskpilotIdentifier,
    taskpilotIssueId: commit.taskpilotIssueId,
    alreadyExisted: commit.alreadyExisted,
  };
}
