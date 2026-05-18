import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
import type { GetGroupBody } from "@/utils/actions/group.validation";

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

export async function getGroup(ctx: GroupCtx, input: GetGroupBody) {
  logger.info("getGroup", {
    emailAccountId: ctx.emailAccountId,
    groupId: input.groupId,
  });

  const group = await prisma.group.findUnique({
    where: { id: input.groupId },
    include: {
      items: true,
      rule: { select: { id: true, name: true } },
    },
  });

  if (!group) throw new NotFoundError(`Group ${input.groupId} not found`);
  if (group.emailAccountId !== ctx.emailAccountId) {
    // Per spec §7: return NOT_FOUND-equivalent to avoid existence leakage.
    throw new NotFoundError(`Group ${input.groupId} not found`);
  }

  return {
    group: {
      id: group.id,
      name: group.name,
      prompt: group.prompt,
      rule: group.rule,
      items: group.items.map((i) => ({
        id: i.id,
        type: i.type,
        value: i.value,
        exclude: i.exclude,
        source: i.source,
        createdAt: i.createdAt.toISOString(),
      })),
      createdAt: group.createdAt.toISOString(),
      updatedAt: group.updatedAt.toISOString(),
    },
  };
}
