import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
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

// Placeholders so test file compiles. Replaced in later tasks.
export async function updateFollowUp(
  _ctx: Ctx,
  _input: UpdateFollowUpInput,
): Promise<unknown> {
  throw new Error("not implemented");
}

export async function previewDeleteFollowUp(
  _ctx: Ctx,
  _id: string,
): Promise<{
  action: "delete_follow_up";
  followUp: Record<string, unknown>;
  willCascade: { hasProviderDraft: boolean };
  irreversible: true;
}> {
  throw new Error("not implemented");
}

export async function deleteFollowUp(
  _ctx: Ctx,
  _id: string,
  _opts: { expectedUpdatedAt?: Date } = {},
): Promise<{ id: string; threadId: string }> {
  throw new Error("not implemented");
}
