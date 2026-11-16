import {
  deleteFollowUp,
  listFollowUps,
  previewDeleteFollowUp,
  updateFollowUp,
} from "@/utils/follow-up/admin/reminders";
import {
  deleteFollowUpInput,
  listFollowUpsInput,
  updateFollowUpInput,
} from "@/utils/follow-up/admin/reminders.validation";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { withDryRunGate } from "@/utils/mcp-server/dry-run";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import {
  getReplyTrackerSettings,
  updateReplyTrackerSettings,
} from "@/utils/reply-tracker/admin/settings";
import {
  getReplyTrackerSettingsInput,
  updateReplyTrackerSettingsInput,
} from "@/utils/reply-tracker/admin/settings.validation";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-reply-tracker-tools");

type ReplyTrackerSettings = Awaited<ReturnType<typeof getReplyTrackerSettings>>;

function authCtx(ctx: McpToolContext) {
  return { userId: ctx.userId, emailAccountId: ctx.emailAccountId };
}

export async function adminReplyTrackerGetSettings(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<ReplyTrackerSettings>> {
  const parsed = getReplyTrackerSettingsInput.safeParse(params ?? {});
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError(
        "Invalid input for admin_reply_tracker_get_settings",
        { issues: parsed.error.issues },
      ),
    );
  }
  try {
    const data = await getReplyTrackerSettings(authCtx(ctx), parsed.data);
    logger.info("tool:admin_reply_tracker_get_settings ok", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminReplyTrackerUpdateSettings(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<ReplyTrackerSettings>> {
  const parsed = updateReplyTrackerSettingsInput.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError(
        "Invalid input for admin_reply_tracker_update_settings",
        { issues: parsed.error.issues },
      ),
    );
  }
  try {
    const data = await updateReplyTrackerSettings(authCtx(ctx), parsed.data);
    logger.info("tool:admin_reply_tracker_update_settings ok", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      fields: Object.keys(parsed.data),
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

type FollowUpListResult = Awaited<ReturnType<typeof listFollowUps>>;
type FollowUpUpdateResult = Awaited<ReturnType<typeof updateFollowUp>>;

export async function adminFollowUpsList(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<FollowUpListResult>> {
  const parsed = listFollowUpsInput.safeParse(params ?? {});
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for admin_follow_ups_list", {
        issues: parsed.error.issues,
      }),
    );
  }
  try {
    const data = await listFollowUps(authCtx(ctx), parsed.data);
    logger.info("tool:admin_follow_ups_list ok", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      count: data.count,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminFollowUpsUpdate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<FollowUpUpdateResult>> {
  const parsed = updateFollowUpInput.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for admin_follow_ups_update", {
        issues: parsed.error.issues,
      }),
    );
  }
  try {
    const data = await updateFollowUp(authCtx(ctx), parsed.data);
    logger.info("tool:admin_follow_ups_update ok", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      id: data.id,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

type FollowUpDeleteResult = Awaited<ReturnType<typeof deleteFollowUp>>;

export async function adminFollowUpsDelete(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<FollowUpDeleteResult>> {
  const parsed = deleteFollowUpInput.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for admin_follow_ups_delete", {
        issues: parsed.error.issues,
      }),
    );
  }
  const { id, confirm, expectedUpdatedAt } = parsed.data;
  try {
    const result = await withDryRunGate({
      confirm,
      preview: () =>
        previewDeleteFollowUp(authCtx(ctx), id) as unknown as Promise<
          Record<string, unknown>
        >,
      commit: () => deleteFollowUp(authCtx(ctx), id, { expectedUpdatedAt }),
    });
    logger.info("tool:admin_follow_ups_delete ok", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      id,
      dryRun: result.ok ? result.dryRun : undefined,
    });
    return result;
  } catch (e) {
    return mapDomainError(e);
  }
}
