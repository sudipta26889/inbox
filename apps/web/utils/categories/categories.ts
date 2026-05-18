import prisma from "@/utils/prisma";

export type DomainCtx = { userId: string; emailAccountId: string };

export async function listCategories(ctx: DomainCtx) {
  const categories = await prisma.category.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    select: {
      id: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: { name: "asc" },
  });
  return { categories };
}
