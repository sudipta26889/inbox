import { z } from "zod";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { NotFoundError, ValidationError } from "@/utils/mcp-server/errors";
import type { McpToolContext } from "@/utils/mcp-server/tools/registry";
import prisma from "@/utils/prisma";
import { buildTaskpilotChatCompletion } from "@/utils/taskpilot/llm";
import { commitTask, draftTaskFromEmail } from "@/utils/taskpilot/service";
import { getEmailUrlForMessage } from "@/utils/url";

const logger = createScopedLogger("mcp-taskpilot-tools");

const inputSchema = z
  .object({
    emailId: z.string().min(1),
    emailAccountId: z.string().optional(),
    preview: z.boolean().optional().default(false),
  })
  .strict();

export async function convertToTaskpilotTask(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  const parsed = inputSchema.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for convert_to_taskpilot_task", {
        issues: parsed.error.issues,
      }),
    );
  }
  const { emailId, preview } = parsed.data;
  const emailAccountId = parsed.data.emailAccountId ?? context.emailAccountId;

  try {
    const emailAccount = await prisma.emailAccount.findFirst({
      where: { id: emailAccountId, userId: context.userId },
      select: {
        id: true,
        email: true,
        userId: true,
        account: { select: { provider: true } },
      },
    });
    if (!emailAccount) {
      throw new NotFoundError("Email account not found for this user");
    }
    const providerType = emailAccount.account?.provider;
    if (!providerType) {
      throw new NotFoundError("Email account has no linked provider");
    }

    const provider = await createEmailProvider({
      emailAccountId: emailAccount.id,
      provider: providerType,
      logger,
    });
    const message = await provider.getMessage(emailId);

    const chatCompletionObject =
      await buildTaskpilotChatCompletion(emailAccountId);

    const draftResult = await draftTaskFromEmail({
      userId: context.userId,
      emailAccountId,
      messageId: message.id,
      email: {
        subject: message.headers.subject ?? "",
        from: message.headers.from ?? "",
        snippet: message.snippet ?? "",
        bodyText: message.textPlain ?? "",
        receivedAt: new Date(Number(message.internalDate) || Date.now()),
      },
      chatCompletionObject,
    });

    if (preview) {
      if (draftResult.alreadyExisted) {
        return {
          ok: true,
          data: { alreadyExisted: true, link: draftResult.link },
        };
      }
      return {
        ok: true,
        data: {
          alreadyExisted: false,
          draft: draftResult.draft,
          projects: draftResult.projects,
        },
      };
    }

    if (draftResult.alreadyExisted && draftResult.link) {
      return {
        ok: true,
        data: {
          taskpilotIdentifier: draftResult.link.taskpilotIdentifier,
          taskpilotIssueId: draftResult.link.taskpilotIssueId,
          alreadyExisted: true,
        },
      };
    }
    if (!draftResult.draft) {
      throw new Error("Internal: draft missing in non-existing branch");
    }

    const committed = await commitTask({
      userId: context.userId,
      emailAccountId,
      messageId: message.id,
      threadId: message.threadId ?? null,
      deepLink: getEmailUrlForMessage(
        message.id,
        message.threadId ?? "",
        emailAccount.email,
        providerType,
      ),
      draft: draftResult.draft,
      source: "CHAT",
    });
    return { ok: true, data: committed };
  } catch (err) {
    return mapDomainError(err);
  }
}
