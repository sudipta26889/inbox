import { createScopedLogger } from "@/utils/logger";
import {
  getKnowledgeBody,
  listKnowledgeQuery,
} from "@/utils/actions/knowledge.validation";
import { getKnowledge, listKnowledge } from "@/utils/knowledge/knowledge";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import type { McpResult } from "@/utils/mcp-server/envelope";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-knowledge-tools");

export async function adminKnowledgeList(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ items: unknown[] }>> {
  logger.info("MCP tool: admin_knowledge_list", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = listKnowledgeQuery.safeParse(params ?? {});
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await listKnowledge(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminKnowledgeGet(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ item: unknown }>> {
  logger.info("MCP tool: admin_knowledge_get", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = getKnowledgeBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await getKnowledge(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
