import { z } from "zod";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
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
