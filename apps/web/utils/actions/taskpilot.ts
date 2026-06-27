"use server";

import { actionClient, actionClientUser } from "@/utils/actions/safe-action";
import {
  commitTaskpilotTaskBody,
  convertEmailDraftBody,
  updateTaskpilotIntegrationBody,
} from "@/utils/actions/taskpilot.validation";
import { createEmailProvider } from "@/utils/email/provider";
import { encryptToken } from "@/utils/encryption";
import prisma from "@/utils/prisma";
import {
  getTaskpilotClientForUser,
  getTaskpilotConfigStatus,
} from "@/utils/taskpilot/config";
import { commitTask, draftTaskFromEmail } from "@/utils/taskpilot/service";
import { getEmailUrlForMessage } from "@/utils/url";

export const convertEmailToTaskpilotTaskDraftAction = actionClient
  .metadata({ name: "convertEmailToTaskpilotTaskDraft" })
  .inputSchema(convertEmailDraftBody)
  .action(
    async ({
      ctx: { userId, emailAccountId, provider: providerType, logger },
      parsedInput: { messageId },
    }) => {
      const provider = await createEmailProvider({
        emailAccountId,
        provider: providerType,
        logger,
      });
      const message = await provider.getMessage(messageId);
      return draftTaskFromEmail({
        userId,
        emailAccountId,
        messageId,
        email: {
          subject: message.headers.subject ?? "",
          from: message.headers.from ?? "",
          snippet: message.snippet ?? "",
          bodyText: message.textPlain ?? "",
          receivedAt: new Date(Number(message.internalDate ?? Date.now())),
        },
      });
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
