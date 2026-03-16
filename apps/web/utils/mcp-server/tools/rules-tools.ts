import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import type { McpToolContext } from "./registry";
import { ActionType } from "@/generated/prisma/client";

const logger = createScopedLogger("mcp-rules-tools");

/**
 * List all automation rules
 */
export async function listRules(context: McpToolContext, params: any) {
  logger.info("MCP tool: list_rules", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  const rules = await prisma.rule.findMany({
    where: {
      emailAccountId: context.emailAccountId,
    },
    select: {
      id: true,
      name: true,
      instructions: true,
      actions: true,
      enabled: true,
      runOnThreads: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return {
    rules: rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      instructions: rule.instructions,
      actions: rule.actions,
      enabled: rule.enabled,
      runOnThreads: rule.runOnThreads,
      createdAt: rule.createdAt.toISOString(),
      updatedAt: rule.updatedAt.toISOString(),
    })),
    count: rules.length,
  };
}

/**
 * Create a new automation rule
 */
export async function createRule(
  context: McpToolContext,
  params: {
    name: string;
    instructions?: string;
    actions: Array<{
      type: string;
      label?: string;
      to?: string;
      cc?: string;
      bcc?: string;
      subject?: string;
      content?: string;
      url?: string;
    }>;
    enabled?: boolean;
    runOnThreads?: boolean;
  }
) {
  logger.info("MCP tool: create_rule", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
    name: params.name,
  });

  // Validate action types
  const validActionTypes = Object.values(ActionType);
  for (const action of params.actions) {
    if (!validActionTypes.includes(action.type as ActionType)) {
      throw new Error(
        `Invalid action type: ${action.type}. Valid types: ${validActionTypes.join(", ")}`
      );
    }
  }

  // Create the rule
  const rule = await prisma.rule.create({
    data: {
      name: params.name,
      instructions: params.instructions || null,
      actions: params.actions,
      enabled: params.enabled ?? true,
      runOnThreads: params.runOnThreads ?? false,
      emailAccountId: context.emailAccountId,
    },
  });

  logger.info("Created automation rule", {
    ruleId: rule.id,
    ruleName: rule.name,
    emailAccountId: context.emailAccountId,
  });

  return {
    success: true,
    rule: {
      id: rule.id,
      name: rule.name,
      instructions: rule.instructions,
      actions: rule.actions,
      enabled: rule.enabled,
      runOnThreads: rule.runOnThreads,
      createdAt: rule.createdAt.toISOString(),
    },
  };
}
