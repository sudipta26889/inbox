import { z } from "zod";
import { env } from "@/env";
import { createEmailProvider } from "@/utils/email/provider";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { NotFoundError, ValidationError } from "@/utils/mcp-server/errors";
import type { McpToolContext } from "@/utils/mcp-server/tools/registry";
import prisma from "@/utils/prisma";
import { taskpilotCache } from "@/utils/taskpilot/cache";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { getTaskpilotConfigForUser } from "@/utils/taskpilot/config";
import { decidePass1 } from "@/utils/taskpilot/decide";
import { commitTask } from "@/utils/taskpilot/service";
import type { CreateTaskDraft } from "@/utils/taskpilot/types";
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

    // Idempotency: if already linked, short-circuit.
    const existing = await prisma.emailTaskLink.findFirst({
      where: { emailAccountId, gmailMessageId: emailId },
    });
    if (existing) {
      return {
        ok: true,
        data: {
          alreadyExisted: true,
          link: {
            taskpilotIdentifier: existing.taskpilotIdentifier,
            taskpilotIssueId: existing.taskpilotIssueId,
            projectId: existing.projectId,
          },
        },
      };
    }

    // Build Pass 1 context.
    const config = await getTaskpilotConfigForUser(context.userId);
    const client = new TaskpilotClient(config);
    const projects = await taskpilotCache.getProjects(context.userId, () =>
      client.listProjects(),
    );
    const labelsByProject: Record<
      string,
      Array<{ id: string; name: string }>
    > = {};
    for (const p of projects) {
      labelsByProject[p.id] = await taskpilotCache.getLabels(
        context.userId,
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
      return mapDomainError(
        new ValidationError("Pass 1 did not produce a CREATE decision", {
          reason: pass1.ok ? "non-CREATE action" : pass1.errorMsg,
        }),
      );
    }

    const draft: CreateTaskDraft = {
      projectId: pass1.decision.draft.projectId,
      title: pass1.decision.draft.title,
      description_html: pass1.decision.draft.descriptionHtml,
      priority: pass1.decision.draft.priority,
      labelNames: pass1.decision.draft.labelNames,
      targetDate: pass1.decision.draft.targetDate ?? undefined,
    };

    if (preview) {
      return { ok: true, data: { alreadyExisted: false, draft, projects } };
    }

    const committed = await commitTask({
      userId: context.userId,
      emailAccountId,
      messageId: message.id,
      threadId: message.threadId ?? null,
      deepLink: getEmailUrlForMessage(
        emailId,
        message.threadId ?? "",
        emailAccount.email,
        providerType,
      ),
      draft,
      source: "CHAT",
    });
    return { ok: true, data: committed };
  } catch (err) {
    return mapDomainError(err);
  }
}
