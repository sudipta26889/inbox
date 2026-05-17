import { z } from "zod";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { createRule, updateRule } from "@/utils/rule/rule";
import {
  createRuleBody,
  updateRuleBody,
} from "@/utils/actions/rule.validation";
import { flattenConditions } from "@/utils/condition";
import {
  mapActionToSanitizedFields,
  resolveActionLabels,
} from "@/utils/rule/action-resolution";
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
    const conditions = flattenConditions(parsed.data.conditions, logger);

    const resolvedActions = await resolveActionLabels(
      parsed.data.actions || [],
      context.emailAccountId,
      provider,
      logger,
    );

    const rule = await createRule({
      result: {
        name: parsed.data.name,
        condition: {
          aiInstructions: conditions.instructions ?? null,
          conditionalOperator: parsed.data.conditionalOperator ?? null,
          static: {
            from: conditions.from ?? null,
            to: conditions.to ?? null,
            subject: conditions.subject ?? null,
          },
        },
        actions: resolvedActions.map(mapActionToSanitizedFields),
      },
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

export async function adminRulesUpdate(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ rule: unknown }>> {
  const parsed = updateRuleBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_update", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    ruleId: parsed.data.id,
  });

  try {
    const existing = await prisma.rule.findFirst({
      where: { id: parsed.data.id, emailAccountId: context.emailAccountId },
      select: { id: true },
    });
    if (!existing) {
      throw new NotFoundError("Rule not found");
    }

    const provider = await getProviderForAccount(context.emailAccountId);
    const conditions = flattenConditions(parsed.data.conditions, logger);

    const resolvedActions = await resolveActionLabels(
      parsed.data.actions || [],
      context.emailAccountId,
      provider,
      logger,
    );

    const rule = await updateRule({
      ruleId: parsed.data.id,
      result: {
        name: parsed.data.name,
        condition: {
          aiInstructions: conditions.instructions ?? null,
          conditionalOperator: parsed.data.conditionalOperator ?? null,
          static: {
            from: conditions.from ?? null,
            to: conditions.to ?? null,
            subject: conditions.subject ?? null,
          },
        },
        actions: resolvedActions.map(mapActionToSanitizedFields),
      },
      emailAccountId: context.emailAccountId,
      provider,
      runOnThreads: parsed.data.runOnThreads ?? undefined,
      logger,
    });

    return { ok: true, data: { rule } };
  } catch (e) {
    return mapDomainError(e);
  }
}
