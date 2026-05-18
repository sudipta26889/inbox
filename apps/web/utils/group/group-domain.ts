import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";
import type {
  AddGroupItemBody,
  CreateGroupBody,
  DeleteGroupBody,
  GetGroupBody,
  RemoveGroupItemBody,
  UpdateGroupBody,
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

export async function updateGroup(ctx: GroupCtx, input: UpdateGroupBody) {
  logger.info("updateGroup", {
    emailAccountId: ctx.emailAccountId,
    groupId: input.groupId,
  });

  const existing = await prisma.group.findUnique({
    where: { id: input.groupId },
    select: { id: true, emailAccountId: true },
  });
  if (!existing || existing.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Group ${input.groupId} not found`);
  }

  try {
    const updated = await prisma.group.update({
      where: { id: input.groupId },
      data: {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
      },
      select: {
        id: true,
        name: true,
        prompt: true,
        updatedAt: true,
      },
    });
    return {
      group: {
        id: updated.id,
        name: updated.name,
        prompt: updated.prompt,
        updatedAt: updated.updatedAt.toISOString(),
      },
    };
  } catch (e) {
    if (isDuplicateError(e)) {
      throw new ConflictError(`A group named "${input.name}" already exists`);
    }
    throw e;
  }
}

export async function previewGroupDeletion(ctx: GroupCtx, input: GetGroupBody) {
  const group = await prisma.group.findUnique({
    where: { id: input.groupId },
    select: {
      id: true,
      name: true,
      emailAccountId: true,
      _count: { select: { items: true } },
    },
  });
  if (!group || group.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Group ${input.groupId} not found`);
  }
  return {
    action: "delete_group" as const,
    group: { id: group.id, name: group.name },
    willCascade: { items: group._count.items },
    irreversible: true as const,
  };
}

export async function deleteGroup(ctx: GroupCtx, input: DeleteGroupBody) {
  logger.info("deleteGroup", {
    emailAccountId: ctx.emailAccountId,
    groupId: input.groupId,
  });

  const existing = await prisma.group.findUnique({
    where: { id: input.groupId },
    select: {
      id: true,
      emailAccountId: true,
      _count: { select: { items: true } },
    },
  });
  if (!existing || existing.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Group ${input.groupId} not found`);
  }

  const deletedItems = existing._count.items;
  await prisma.group.delete({ where: { id: input.groupId } });
  return { deletedGroupId: input.groupId, deletedItems };
}

export async function addGroupItem(ctx: GroupCtx, input: AddGroupItemBody) {
  logger.info("addGroupItem", {
    emailAccountId: ctx.emailAccountId,
    groupId: input.groupId,
  });

  const group = await prisma.group.findUnique({
    where: { id: input.groupId },
    select: { id: true, emailAccountId: true },
  });
  if (!group || group.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Group ${input.groupId} not found`);
  }

  try {
    const item = await prisma.groupItem.create({
      data: {
        groupId: input.groupId,
        type: input.type,
        value: input.value,
        exclude: input.exclude ?? false,
      },
    });
    return {
      item: {
        id: item.id,
        type: item.type,
        value: item.value,
        exclude: item.exclude,
      },
    };
  } catch (e) {
    if (isDuplicateError(e)) {
      const existing = await prisma.groupItem.findUnique({
        where: {
          groupId_type_value: {
            groupId: input.groupId,
            type: input.type,
            value: input.value,
          },
        },
      });
      if (existing) {
        return {
          item: {
            id: existing.id,
            type: existing.type,
            value: existing.value,
            exclude: existing.exclude,
          },
        };
      }
    }
    throw e;
  }
}

export async function removeGroupItem(
  ctx: GroupCtx,
  input: RemoveGroupItemBody,
) {
  logger.info("removeGroupItem", {
    emailAccountId: ctx.emailAccountId,
    itemId: input.itemId,
  });

  const item = await prisma.groupItem.findUnique({
    where: { id: input.itemId },
    select: { id: true, group: { select: { emailAccountId: true } } },
  });
  if (!item || item.group?.emailAccountId !== ctx.emailAccountId) {
    throw new NotFoundError(`Group item ${input.itemId} not found`);
  }

  await prisma.groupItem.delete({ where: { id: input.itemId } });
  return { deletedItemId: input.itemId };
}
