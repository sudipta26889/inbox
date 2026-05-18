import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
import type {
  GetKnowledgeBody,
  ListKnowledgeQuery,
} from "@/utils/actions/knowledge.validation";
import type { Knowledge } from "@/generated/prisma/client";

const logger = createScopedLogger("knowledge-domain");

export type KnowledgeCtx = { userId: string; emailAccountId: string };

export async function listKnowledge(
  ctx: KnowledgeCtx,
  input: ListKnowledgeQuery,
): Promise<{ items: Knowledge[] }> {
  logger.info("listKnowledge", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
    limit: input.limit,
  });

  const items = await prisma.knowledge.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    orderBy: { updatedAt: "desc" },
    take: input.limit ?? undefined,
  });
  return { items };
}

export async function getKnowledge(
  ctx: KnowledgeCtx,
  input: GetKnowledgeBody,
): Promise<{ item: Knowledge }> {
  const item = await prisma.knowledge.findFirst({
    where: { id: input.id, emailAccountId: ctx.emailAccountId },
  });
  if (!item) throw new NotFoundError(`Knowledge ${input.id} not found`);
  return { item };
}
