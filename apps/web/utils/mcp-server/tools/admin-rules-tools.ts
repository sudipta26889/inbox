import { z } from "zod";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { createRule } from "@/utils/rule/rule";
import { createRuleBody } from "@/utils/actions/rule.validation";
import { flattenConditions } from "@/utils/condition";
import { mapDomainError } from "../error-mapper";
import { NotFoundError, ValidationError } from "../errors";
import type { McpToolContext } from "./registry";
import type { McpResult } from "../envelope";

const logger = createScopedLogger("mcp-admin-rules-tools");

export async function adminRulesList(
  context: McpToolContext,
  _params: unknown,
): Promise<McpResult<{ rules: unknown[]; count: number }>> {
  logger.info("admin_rules_list", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  try {
    const rules = await prisma.rule.findMany({
      where: { emailAccountId: context.emailAccountId },
      include: { actions: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });

    return {
      ok: true,
      data: {
        rules: rules.map((rule) => ({
          id: rule.id,
          name: rule.name,
          enabled: rule.enabled,
          runOnThreads: rule.runOnThreads,
          displayOrder: rule.displayOrder,
          systemType: rule.systemType,
          instructions: rule.instructions,
          createdAt: rule.createdAt.toISOString(),
          updatedAt: rule.updatedAt.toISOString(),
          actions: rule.actions,
        })),
        count: rules.length,
      },
    };
  } catch (e) {
    return mapDomainError(e);
  }
}

const adminRulesGetSchema = z.object({ id: z.string().min(1) });

export async function adminRulesGet(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ rule: unknown }>> {
  const parsed = adminRulesGetSchema.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_get", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    ruleId: parsed.data.id,
  });

  try {
    const rule = await prisma.rule.findFirst({
      where: { id: parsed.data.id, emailAccountId: context.emailAccountId },
      include: { actions: true, group: true },
    });

    if (!rule) {
      throw new NotFoundError("Rule not found");
    }

    return { ok: true, data: { rule } };
  } catch (e) {
    return mapDomainError(e);
  }
}

async function getProviderForAccount(emailAccountId: string): Promise<string> {
  const ea = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { account: { select: { provider: true } } },
  });
  if (!ea?.account?.provider) {
    throw new NotFoundError("Email account not found");
  }
  return ea.account.provider;
}

function buildDomainResultFromCreateBody(
  input: ReturnType<typeof createRuleBody.parse>,
) {
  const conditions = flattenConditions(input.conditions, logger);
  return {
    name: input.name,
    condition: {
      aiInstructions: conditions.instructions ?? null,
      conditionalOperator: input.conditionalOperator ?? null,
      static: {
        from: conditions.from ?? null,
        to: conditions.to ?? null,
        subject: conditions.subject ?? null,
      },
    },
    actions: input.actions.map((a) => ({
      type: a.type,
      fields: {
        label: a.labelId?.name ?? null,
        to: a.to?.value ?? null,
        cc: a.cc?.value ?? null,
        bcc: a.bcc?.value ?? null,
        subject: a.subject?.value ?? null,
        content: a.content?.value ?? null,
        webhookUrl: a.url?.value ?? null,
        folderName: a.folderName?.value ?? null,
      },
      labelId: a.labelId?.value ?? null,
      folderId: a.folderId?.value ?? null,
      delayInMinutes: a.delayInMinutes ?? null,
      staticAttachments: a.staticAttachments ?? null,
      haIntegrationType: a.haIntegrationType ?? null,
      haWebhookId: a.haWebhookId ?? null,
      haMqttTopic: a.haMqttTopic ?? null,
      haServiceDomain: a.haServiceDomain ?? null,
      haServiceName: a.haServiceName ?? null,
      haServiceData: a.haServiceData ?? null,
      haEntityId: a.haEntityId ?? null,
    })),
  };
}

export async function adminRulesCreate(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ rule: unknown }>> {
  const parsed = createRuleBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_create", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    name: parsed.data.name,
  });

  try {
    const provider = await getProviderForAccount(context.emailAccountId);
    const result = buildDomainResultFromCreateBody(parsed.data);

    const rule = await createRule({
      result,
      emailAccountId: context.emailAccountId,
      provider,
      runOnThreads: parsed.data.runOnThreads ?? true,
      logger,
    });

    return { ok: true, data: { rule } };
  } catch (e) {
    return mapDomainError(e);
  }
}
