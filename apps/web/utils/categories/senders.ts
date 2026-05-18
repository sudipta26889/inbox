import prisma from "@/utils/prisma";
import type { ListSendersBody } from "./validation";

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
