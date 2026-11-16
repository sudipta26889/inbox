import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-rules-tools");

/**
 * List all automation rules.
 *
 * Rule creation lives in admin-rules-tools (`admin_rules_create`), which is
 * what the registry exposes. A second `createRule` here was never imported and
 * could not have worked: it assigned `params.actions` straight to the `actions`
 * relation, which Prisma rejects.
 */
export async function listRules(context: McpToolContext) {
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
