import { z } from "zod";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import {
  createRule,
  deleteRule as deleteRuleDomain,
  updateRule,
} from "@/utils/rule/rule";
import {
  createRuleBody,
  deleteRuleBody,
  toggleRuleBody,
  updateRuleBody,
} from "@/utils/actions/rule.validation";
import { flattenConditions } from "@/utils/condition";
import {
  mapActionToSanitizedFields,
  resolveActionLabels,
} from "@/utils/rule/action-resolution";
import { mapDomainError } from "../error-mapper";
import { NotFoundError, StaleStateError, ValidationError } from "../errors";
import { withDryRunGate } from "../dry-run";
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

const adminRulesDeleteSchema = deleteRuleBody.extend({
  confirm: z.boolean().optional(),
});

export async function adminRulesDelete(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ deleted: true; id: string }>> {
  const parsed = adminRulesDeleteSchema.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_delete", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    ruleId: parsed.data.id,
    confirm: parsed.data.confirm === true,
  });

  try {
    return await withDryRunGate({
      confirm: parsed.data.confirm,
      preview: async () => {
        const rule = await prisma.rule.findFirst({
          where: {
            id: parsed.data.id,
            emailAccountId: context.emailAccountId,
          },
          select: { id: true, name: true, groupId: true, actions: true },
        });
        if (!rule) throw new NotFoundError("Rule not found");
        return {
          action: "delete_rule",
          rule: {
            id: rule.id,
            name: rule.name,
            actionCount: rule.actions.length,
          },
          irreversible: true,
        };
      },
      commit: async () => {
        const rule = await prisma.rule.findFirst({
          where: {
            id: parsed.data.id,
            emailAccountId: context.emailAccountId,
          },
          select: { id: true, groupId: true },
        });
        if (!rule) throw new StaleStateError("Rule no longer exists");
        await deleteRuleDomain({
          ruleId: rule.id,
          emailAccountId: context.emailAccountId,
          groupId: rule.groupId,
        });
        return { deleted: true as const, id: rule.id };
      },
    });
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminRulesSetEnabled(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ rule: unknown }>> {
  const parsed = toggleRuleBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_set_enabled", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    ruleId: parsed.data.ruleId,
    systemType: parsed.data.systemType,
    enabled: parsed.data.enabled,
  });

  try {
    if (!parsed.data.ruleId) {
      throw new ValidationError(
        "admin_rules_set_enabled requires ruleId (systemType lookup not supported by this tool)",
      );
    }

    const existing = await prisma.rule.findFirst({
      where: {
        id: parsed.data.ruleId,
        emailAccountId: context.emailAccountId,
      },
      select: { id: true },
    });
    if (!existing) throw new NotFoundError("Rule not found");

    const rule = await prisma.rule.update({
      where: {
        id: parsed.data.ruleId,
        emailAccountId: context.emailAccountId,
      },
      data: { enabled: parsed.data.enabled },
      include: { actions: true, group: true },
    });

    return { ok: true, data: { rule } };
  } catch (e) {
    return mapDomainError(e);
  }
}

const adminRulesReorderSchema = z.object({
  ruleIds: z
    .array(z.string().min(1))
    .min(1, "ruleIds must contain at least one id")
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "ruleIds must not contain duplicates",
    }),
});

export async function adminRulesReorder(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<{ reordered: number }>> {
  const parsed = adminRulesReorderSchema.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }

  logger.info("admin_rules_reorder", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    count: parsed.data.ruleIds.length,
  });

  try {
    const ownedRules = await prisma.rule.findMany({
      where: { emailAccountId: context.emailAccountId },
      select: { id: true },
    });
    const ownedIds = new Set(ownedRules.map((r) => r.id));

    const suppliedIds = new Set(parsed.data.ruleIds);
    const missingFromSupplied = [...ownedIds].filter(
      (id) => !suppliedIds.has(id),
    );
    const extraInSupplied = parsed.data.ruleIds.filter(
      (id) => !ownedIds.has(id),
    );

    if (missingFromSupplied.length > 0 || extraInSupplied.length > 0) {
      throw new ValidationError(
        "ruleIds must be exactly the set of rules owned by this email account",
        { missingFromSupplied, extraInSupplied },
      );
    }

    await prisma.$transaction(
      parsed.data.ruleIds.map((id, index) =>
        prisma.rule.update({
          where: { id, emailAccountId: context.emailAccountId },
          data: { displayOrder: index },
        }),
      ),
    );

    return { ok: true, data: { reordered: parsed.data.ruleIds.length } };
  } catch (e) {
    return mapDomainError(e);
  }
}
