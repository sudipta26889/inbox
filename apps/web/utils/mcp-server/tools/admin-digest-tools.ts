import { createScopedLogger } from "@/utils/logger";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import {
  getDigestConfigBody,
  saveDigestScheduleBody,
} from "@/utils/actions/settings.validation";
import { getDigestConfig, updateDigestSchedule } from "@/utils/digest/domain";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-digest-tools");

export async function adminDigestGet(ctx: McpToolContext, params: unknown) {
  const started = Date.now();
  const parsed = getDigestConfigBody.safeParse(params);
  if (!parsed.success) {
    logger.info("admin_digest_get validation error", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      durationMs: Date.now() - started,
      outcome: "validation_error",
    });
    return {
      ok: false as const,
      error: {
        code: "VALIDATION_ERROR" as const,
        message: "Invalid input",
        details: parsed.error.issues,
      },
    };
  }

  try {
    const data = await getDigestConfig({
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    });
    logger.info("admin_digest_get success", {
      tool: "admin_digest_get",
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return { ok: true as const, data };
  } catch (e) {
    logger.error("admin_digest_get failed", { error: e });
    return mapDomainError(e);
  }
}

export async function adminDigestUpdateSchedule(
  ctx: McpToolContext,
  params: unknown,
) {
  const started = Date.now();
  const parsed = saveDigestScheduleBody.safeParse(params);
  if (!parsed.success) {
    logger.info("admin_digest_update_schedule validation error", {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      durationMs: Date.now() - started,
      outcome: "validation_error",
    });
    return {
      ok: false as const,
      error: {
        code: "VALIDATION_ERROR" as const,
        message: "Invalid input",
        details: parsed.error.issues,
      },
    };
  }

  try {
    const data = await updateDigestSchedule(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    logger.info("admin_digest_update_schedule success", {
      tool: "admin_digest_update_schedule",
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
      durationMs: Date.now() - started,
      outcome: "success",
    });
    return { ok: true as const, data };
  } catch (e) {
    logger.error("admin_digest_update_schedule failed", { error: e });
    return mapDomainError(e);
  }
}
