"use server";

import { actionClient, actionClientUser } from "@/utils/actions/safe-action";
import {
  commitTaskpilotTaskBody,
  convertEmailDraftBody,
  updateTaskpilotIntegrationBody,
} from "@/utils/actions/taskpilot.validation";
import { env } from "@/env";
import { createEmailProvider } from "@/utils/email/provider";
import { encryptToken } from "@/utils/encryption";
import prisma from "@/utils/prisma";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import {
  getTaskpilotClientForUser,
  getTaskpilotConfigForUser,
  getTaskpilotConfigStatus,
} from "@/utils/taskpilot/config";
import { decidePass1 } from "@/utils/taskpilot/decide";
import { commitTask } from "@/utils/taskpilot/service";
import type { CreateTaskDraft } from "@/utils/taskpilot/types";
import { getEmailUrlForMessage } from "@/utils/url";

export const convertEmailToTaskpilotTaskDraftAction = actionClient
  .metadata({ name: "convertEmailToTaskpilotTaskDraft" })
  .inputSchema(convertEmailDraftBody)
  .action(
    async ({
      ctx: { userId, emailAccountId, provider: providerType, logger },
      parsedInput: { messageId },
    }) => {
      const existing = await prisma.emailTaskLink.findFirst({
        where: { emailAccountId, gmailMessageId: messageId },
      });
      if (existing) {
        return {
          alreadyExisted: true as const,
          link: {
            taskpilotIdentifier: existing.taskpilotIdentifier,
            taskpilotIssueId: existing.taskpilotIssueId,
            projectId: existing.projectId,
          },
        };
      }

      const provider = await createEmailProvider({
        emailAccountId,
        provider: providerType,
        logger,
      });
      const message = await provider.getMessage(messageId);

      const config = await getTaskpilotConfigForUser(userId);
      const client = new TaskpilotClient(config);
      const projects = await taskpilotCache.getProjects(userId, () =>
        client.listProjects(),
      );
      const labelsByProject: Record<
        string,
        Array<{ id: string; name: string }>
      > = {};
      for (const p of projects) {
        labelsByProject[p.id] = await taskpilotCache.getLabels(
          userId,
          p.id,
          () => client.listLabels(p.id),
        );
      }

      const pass1 = await decidePass1({
        mode: "force_create",
        email: {
          from: message.headers.from ?? "",
          subject: message.headers.subject ?? "",
          bodyText: message.textPlain ?? "",
          receivedAt: new Date(Number(message.internalDate) || Date.now()),
        },
        candidates: [],
        canCreate: true,
        projects,
        labelsByProject,
        todayISO: new Date().toISOString().slice(0, 10),
        model: env.TASKPILOT_DECIDER_MODEL,
        effort: env.TASKPILOT_DECIDER_REASONING_EFFORT,
        maxTokens: env.TASKPILOT_DECIDER_MAX_TOKENS,
        timeoutMs: env.TASKPILOT_DECIDER_TIMEOUT_MS,
      });

      if (!pass1.ok || pass1.decision.action !== "CREATE") {
        return {
          alreadyExisted: false as const,
          error: pass1.ok ? "force_create violation" : pass1.errorMsg,
        };
      }

      const draft: CreateTaskDraft = {
        projectId: pass1.decision.draft.projectId,
        title: pass1.decision.draft.title,
        description_html: pass1.decision.draft.descriptionHtml,
        priority: pass1.decision.draft.priority,
        labelNames: pass1.decision.draft.labelNames,
        targetDate: pass1.decision.draft.targetDate ?? undefined,
      };

      return {
        alreadyExisted: false as const,
        draft,
        projects,
        labelsByProject,
      };
    },
  );

export const commitTaskpilotTaskAction = actionClient
  .metadata({ name: "commitTaskpilotTask" })
  .inputSchema(commitTaskpilotTaskBody)
  .action(
    async ({
      ctx: {
        userId,
        emailAccountId,
        emailAccount,
        provider: providerType,
        logger,
      },
      parsedInput: { messageId, draft },
    }) => {
      const provider = await createEmailProvider({
        emailAccountId,
        provider: providerType,
        logger,
      });
      const message = await provider.getMessage(messageId);
      const threadId = message.threadId;
      return commitTask({
        userId,
        emailAccountId,
        messageId,
        threadId: threadId || null,
        deepLink: getEmailUrlForMessage(
          messageId,
          threadId,
          emailAccount.email,
          providerType,
        ),
        draft,
        source: "MANUAL",
      });
    },
  );

export const getTaskpilotIntegrationStatusAction = actionClientUser
  .metadata({ name: "getTaskpilotIntegrationStatus" })
  .action(async ({ ctx: { userId } }) => {
    return getTaskpilotConfigStatus(userId);
  });

export const updateTaskpilotIntegrationAction = actionClientUser
  .metadata({ name: "updateTaskpilotIntegration" })
  .inputSchema(updateTaskpilotIntegrationBody)
  .action(
    async ({ ctx: { userId }, parsedInput: { apiKey, workspaceSlug } }) => {
      await prisma.user.update({
        where: { id: userId },
        data: {
          taskpilotApiKey: apiKey === null ? null : encryptToken(apiKey),
          taskpilotWorkspaceSlug: workspaceSlug,
        },
      });
      return { ok: true as const };
    },
  );

export const testTaskpilotConnectionAction = actionClientUser
  .metadata({ name: "testTaskpilotConnection" })
  .action(async ({ ctx: { userId } }) => {
    const client = await getTaskpilotClientForUser(userId);
    const projects = await client.listProjects();
    return { ok: true as const, projectCount: projects.length };
  });
