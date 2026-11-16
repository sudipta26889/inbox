import { createScopedLogger } from "@/utils/logger";
import { NotFoundError, StaleStateError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";
import type {
  ListFollowUpsInput,
  UpdateFollowUpInput,
} from "./reminders.validation";

const logger = createScopedLogger("follow-up-admin");

type Ctx = { userId: string; emailAccountId: string };

async function assertOwnership(ctx: Ctx) {
  const ea = await prisma.emailAccount.findFirst({
    where: { id: ctx.emailAccountId, userId: ctx.userId },
    select: { id: true },
  });
  if (!ea) throw new NotFoundError("EmailAccount not found");
}

export async function listFollowUps(ctx: Ctx, input: ListFollowUpsInput) {
  await assertOwnership(ctx);

  const rows = await prisma.threadTracker.findMany({
    where: {
      emailAccountId: ctx.emailAccountId,
      ...(input.appliedOnly ? { followUpAppliedAt: { not: null } } : {}),
      ...(input.resolved !== undefined ? { resolved: input.resolved } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: input.limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    select: {
      id: true,
      threadId: true,
      messageId: true,
      sentAt: true,
      type: true,
      resolved: true,
      followUpAppliedAt: true,
      followUpDraftId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  const hasMore = rows.length > input.limit;
  const items = hasMore ? rows.slice(0, input.limit) : rows;
  const nextCursor = hasMore ? items[items.length - 1]!.id : null;

  logger.trace("listFollowUps", { count: items.length });
  return { items, nextCursor, count: items.length };
}

export async function updateFollowUp(ctx: Ctx, input: UpdateFollowUpInput) {
  await assertOwnership(ctx);

  const existing = await prisma.threadTracker.findFirst({
    where: { id: input.id, emailAccountId: ctx.emailAccountId },
    select: { id: true },
  });
  if (!existing) throw new NotFoundError("ThreadTracker not found");

  const updated = await prisma.threadTracker.update({
    where: { id: input.id },
    data: {
      ...(input.resolved !== undefined && { resolved: input.resolved }),
      ...(input.followUpAppliedAt !== undefined && {
        followUpAppliedAt: input.followUpAppliedAt,
      }),
      ...(input.followUpDraftId !== undefined && {
        followUpDraftId: input.followUpDraftId,
      }),
    },
    select: {
      id: true,
      threadId: true,
      messageId: true,
      sentAt: true,
      type: true,
      resolved: true,
      followUpAppliedAt: true,
      followUpDraftId: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  logger.info("updateFollowUp", { id: updated.id });
  return updated;
}

async function loadOwnedTracker(ctx: Ctx, id: string) {
  const row = await prisma.threadTracker.findFirst({
    where: { id, emailAccountId: ctx.emailAccountId },
    select: {
      id: true,
      threadId: true,
      messageId: true,
      type: true,
      resolved: true,
      followUpAppliedAt: true,
      followUpDraftId: true,
      updatedAt: true,
    },
  });
  if (!row) throw new NotFoundError("ThreadTracker not found");
  return row;
}

export async function previewDeleteFollowUp(ctx: Ctx, id: string) {
  await assertOwnership(ctx);
  const row = await loadOwnedTracker(ctx, id);
  return {
    action: "delete_follow_up" as const,
    followUp: {
      id: row.id,
      threadId: row.threadId,
      messageId: row.messageId,
      type: row.type,
      resolved: row.resolved,
      followUpAppliedAt: row.followUpAppliedAt,
      followUpDraftId: row.followUpDraftId,
      updatedAt: row.updatedAt,
    },
    willCascade: { hasProviderDraft: !!row.followUpDraftId },
    irreversible: true as const,
  };
}

export async function deleteFollowUp(
  ctx: Ctx,
  id: string,
  opts: { expectedUpdatedAt?: Date } = {},
) {
  await assertOwnership(ctx);
  const row = await loadOwnedTracker(ctx, id);

  if (
    opts.expectedUpdatedAt &&
    row.updatedAt.getTime() !== opts.expectedUpdatedAt.getTime()
  ) {
    throw new StaleStateError("ThreadTracker has been modified since preview", {
      expected: opts.expectedUpdatedAt,
      actual: row.updatedAt,
    });
  }

  await prisma.threadTracker.delete({ where: { id } });
  logger.info("deleteFollowUp", { id });
  return { id: row.id, threadId: row.threadId };
}
