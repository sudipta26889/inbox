import prisma from "@/utils/prisma";
import { upsertSenderRecord } from "@/utils/senders/record";
import { NotFoundError } from "@/utils/mcp-server/errors";
import type { CategorizeSendersBody, ListSendersBody } from "./validation";

export type DomainCtx = { userId: string; emailAccountId: string };

export async function listSenders(ctx: DomainCtx, input: ListSendersBody) {
  const senders = await prisma.newsletter.findMany({
    where: {
      emailAccountId: ctx.emailAccountId,
      ...(input.categoryId && { categoryId: input.categoryId }),
    },
    select: {
      id: true,
      email: true,
      name: true,
      categoryId: true,
      category: { select: { id: true, name: true } },
    },
    orderBy: { email: "asc" },
    take: input.limit,
    ...(input.cursor && { skip: 1, cursor: { id: input.cursor } }),
  });

  const nextCursor =
    senders.length === input.limit ? senders[senders.length - 1].id : null;
  return { senders, nextCursor };
}

export async function categorizeSenders(
  ctx: DomainCtx,
  input: CategorizeSendersBody,
) {
  // Pre-load valid category IDs for this account (single query).
  const categoryIds = Array.from(
    new Set(input.assignments.map((a) => a.categoryId)),
  );
  const validCategories = await prisma.category.findMany({
    where: { emailAccountId: ctx.emailAccountId, id: { in: categoryIds } },
    select: { id: true },
  });
  const validIdSet = new Set(validCategories.map((c) => c.id));

  const succeeded: string[] = [];
  const failed: Array<{
    id: string;
    error: { code: string; message: string };
  }> = [];

  // Per-item commit; no prisma.$transaction(async (tx) => ...) per project rule.
  for (const a of input.assignments) {
    try {
      if (!validIdSet.has(a.categoryId)) {
        throw new NotFoundError(`Category ${a.categoryId} not found`);
      }
      await upsertSenderRecord({
        emailAccountId: ctx.emailAccountId,
        newsletterEmail: a.sender,
        changes: { categoryId: a.categoryId },
      });
      succeeded.push(a.sender);
    } catch (e) {
      const err = e as Error;
      const code =
        err.name === "NotFoundError" ? "NOT_FOUND" : "INTERNAL_ERROR";
      failed.push({ id: a.sender, error: { code, message: err.message } });
    }
  }

  return {
    succeeded,
    failed,
    total: input.assignments.length,
    successCount: succeeded.length,
    failureCount: failed.length,
  };
}
