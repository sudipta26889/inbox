import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("group-domain");

export type GroupCtx = { userId: string; emailAccountId: string };

export async function listGroups(ctx: GroupCtx) {
  logger.info("listGroups", { emailAccountId: ctx.emailAccountId });

  const groups = await prisma.group.findMany({
    where: { emailAccountId: ctx.emailAccountId },
    select: {
      id: true,
      name: true,
      prompt: true,
      createdAt: true,
      updatedAt: true,
      rule: { select: { id: true, name: true } },
      _count: { select: { items: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      prompt: g.prompt,
      rule: g.rule,
      itemCount: g._count.items,
      createdAt: g.createdAt.toISOString(),
      updatedAt: g.updatedAt.toISOString(),
    })),
  };
}
