import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import {
  createKnowledgeBody,
  deleteKnowledgeConfirmBody,
  getKnowledgeBody,
  listKnowledgeQuery,
  updateKnowledgeBody,
} from "@/utils/actions/knowledge.validation";
import {
  createKnowledge,
  deleteKnowledge,
  getKnowledge,
  listKnowledge,
  updateKnowledge,
} from "@/utils/knowledge/knowledge";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { withDryRunGate } from "@/utils/mcp-server/dry-run";
import {
  NotFoundError,
  StaleStateError,
  ValidationError,
} from "@/utils/mcp-server/errors";
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

export async function adminKnowledgeCreate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ item: unknown }>> {
  logger.info("MCP tool: admin_knowledge_create", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = createKnowledgeBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await createKnowledge(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminKnowledgeUpdate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ item: unknown }>> {
  logger.info("MCP tool: admin_knowledge_update", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = updateKnowledgeBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await updateKnowledge(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminKnowledgeDelete(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ id: string }>> {
  logger.info("MCP tool: admin_knowledge_delete", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = deleteKnowledgeConfirmBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  const { id, confirm } = parsed.data;
  const domainCtx = {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  };

  try {
    return await withDryRunGate({
      confirm,
      preview: async () => {
        const existing = await prisma.knowledge.findFirst({
          where: { id, emailAccountId: ctx.emailAccountId },
          select: { id: true, title: true, updatedAt: true },
        });
        if (!existing) throw new NotFoundError(`Knowledge ${id} not found`);
        return {
          action: "delete_knowledge",
          knowledge: {
            id: existing.id,
            title: existing.title,
            updatedAt: existing.updatedAt.toISOString(),
          },
          irreversible: true,
        };
      },
      commit: async () => {
        const existing = await prisma.knowledge.findFirst({
          where: { id, emailAccountId: ctx.emailAccountId },
          select: { id: true },
        });
        if (!existing) {
          throw new StaleStateError(`Knowledge ${id} no longer exists`);
        }
        return await deleteKnowledge(domainCtx, { id });
      },
    });
  } catch (e) {
    return mapDomainError(e);
  }
}
