import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";
import type {
  CreateKnowledgeBody,
  DeleteKnowledgeBody,
  GetKnowledgeBody,
  ListKnowledgeQuery,
  UpdateKnowledgeBody,
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

export async function createKnowledge(
  ctx: KnowledgeCtx,
  input: CreateKnowledgeBody,
): Promise<{ item: Knowledge }> {
  logger.info("createKnowledge", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  logger.trace("createKnowledge content", {
    title: input.title,
    content: input.content,
  });

  try {
    const item = await prisma.knowledge.create({
      data: {
        emailAccountId: ctx.emailAccountId,
        title: input.title,
        content: input.content,
      },
    });
    return { item };
  } catch (error) {
    if (isDuplicateError(error, "title")) {
      throw new ConflictError(
        `Knowledge item with title "${input.title}" already exists`,
      );
    }
    throw error;
  }
}

export async function deleteKnowledge(
  ctx: KnowledgeCtx,
  input: DeleteKnowledgeBody,
): Promise<{ id: string }> {
  logger.info("deleteKnowledge", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
    id: input.id,
  });

  const existing = await prisma.knowledge.findFirst({
    where: { id: input.id, emailAccountId: ctx.emailAccountId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError(`Knowledge ${input.id} not found`);

  await prisma.knowledge.delete({ where: { id: input.id } });
  return { id: input.id };
}

export async function updateKnowledge(
  ctx: KnowledgeCtx,
  input: UpdateKnowledgeBody,
): Promise<{ item: Knowledge }> {
  logger.info("updateKnowledge", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
    id: input.id,
  });

  const existing = await prisma.knowledge.findFirst({
    where: { id: input.id, emailAccountId: ctx.emailAccountId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError(`Knowledge ${input.id} not found`);

  try {
    const item = await prisma.knowledge.update({
      where: { id: input.id },
      data: { title: input.title, content: input.content },
    });
    return { item };
  } catch (error) {
    if (isDuplicateError(error, "title")) {
      throw new ConflictError(
        `Knowledge item with title "${input.title}" already exists`,
      );
    }
    throw error;
  }
}
