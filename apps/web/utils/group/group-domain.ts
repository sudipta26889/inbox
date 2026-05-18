import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";
import type {
  CreateGroupBody,
  GetGroupBody,
} from "@/utils/actions/group.validation";

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

export async function createGroup(ctx: GroupCtx, input: CreateGroupBody) {
  logger.info("createGroup", {
    emailAccountId: ctx.emailAccountId,
    ruleId: input.ruleId,
  });

  const rule = await prisma.rule.findUnique({
    where: { id: input.ruleId },
    select: { id: true, name: true, groupId: true, emailAccountId: true },
  });
  if (!rule || rule.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Rule ${input.ruleId} not found`);
  }
  if (rule.groupId) return { groupId: rule.groupId };

  try {
    const group = await prisma.group.create({
      data: {
        name: rule.name,
        emailAccountId: ctx.emailAccountId,
        rule: { connect: { id: rule.id } },
      },
    });
    return { groupId: group.id };
  } catch (e) {
    if (isDuplicateError(e)) {
      throw new ConflictError(`A group named "${rule.name}" already exists`);
    }
    throw e;
  }
}
