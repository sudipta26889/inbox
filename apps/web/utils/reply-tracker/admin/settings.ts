import { ActionType, SystemType } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";
import type {
  GetReplyTrackerSettingsInput,
  UpdateReplyTrackerSettingsInput,
} from "./settings.validation";

const logger = createScopedLogger("reply-tracker-admin");

type Ctx = { userId: string; emailAccountId: string };

export async function getReplyTrackerSettings(
  ctx: Ctx,
  _input: GetReplyTrackerSettingsInput,
) {
  const account = await loadOwnedAccount(ctx);

  const rule = await prisma.rule.findUnique({
    where: {
      emailAccountId_systemType: {
        emailAccountId: ctx.emailAccountId,
        systemType: SystemType.TO_REPLY,
      },
    },
    include: { actions: { select: { type: true } } },
  });

  const draftRepliesEnabled =
    !!rule?.enabled &&
    !!rule.actions.find((a) => a.type === ActionType.DRAFT_EMAIL);

  logger.trace("getReplyTrackerSettings", {
    emailAccountId: ctx.emailAccountId,
  });

  return {
    draftRepliesEnabled,
    draftReplyConfidence: account.draftReplyConfidence,
    allowHiddenAiDraftLinks: account.allowHiddenAiDraftLinks,
    toReplyRuleId: rule?.id ?? null,
  };
}

export async function updateReplyTrackerSettings(
  ctx: Ctx,
  input: UpdateReplyTrackerSettingsInput,
) {
  await loadOwnedAccount(ctx);

  if (
    input.draftReplyConfidence !== undefined ||
    input.allowHiddenAiDraftLinks !== undefined
  ) {
    await prisma.emailAccount.update({
      where: { id: ctx.emailAccountId },
      data: {
        ...(input.draftReplyConfidence !== undefined && {
          draftReplyConfidence: input.draftReplyConfidence,
        }),
        ...(input.allowHiddenAiDraftLinks !== undefined && {
          allowHiddenAiDraftLinks: input.allowHiddenAiDraftLinks,
        }),
      },
    });
  }

  if (input.draftRepliesEnabled !== undefined) {
    await setDraftRepliesEnabled(ctx.emailAccountId, input.draftRepliesEnabled);
  }

  return getReplyTrackerSettings(ctx, {});
}

async function loadOwnedAccount(ctx: Ctx) {
  const account = await prisma.emailAccount.findFirst({
    where: { id: ctx.emailAccountId, userId: ctx.userId },
    select: {
      id: true,
      draftReplyConfidence: true,
      allowHiddenAiDraftLinks: true,
    },
  });
  if (!account) throw new NotFoundError("EmailAccount not found");
  return account;
}

async function setDraftRepliesEnabled(emailAccountId: string, enable: boolean) {
  const existing = await prisma.rule.findUnique({
    where: {
      emailAccountId_systemType: {
        emailAccountId,
        systemType: SystemType.TO_REPLY,
      },
    },
    include: { actions: true },
  });

  let rule = existing;
  if (!rule) {
    if (!enable) return;
    rule = await prisma.rule.create({
      data: {
        name: "To Reply",
        emailAccountId,
        systemType: SystemType.TO_REPLY,
        enabled: true,
      },
      include: { actions: true },
    });
  }

  const hasDraftAction = rule.actions.some(
    (a) => a.type === ActionType.DRAFT_EMAIL,
  );
  if (enable && !hasDraftAction) {
    await prisma.action.create({
      data: { ruleId: rule.id, type: ActionType.DRAFT_EMAIL },
    });
  } else if (!enable && hasDraftAction) {
    await prisma.action.deleteMany({
      where: { ruleId: rule.id, type: ActionType.DRAFT_EMAIL },
    });
  }
}
