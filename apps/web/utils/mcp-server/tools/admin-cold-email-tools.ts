import { coldEmailUpdateSettingsBody } from "@/utils/actions/cold-email.validation";
import {
  type ColdEmailSettings,
  getColdEmailSettings,
  updateColdEmailSettings,
} from "@/utils/cold-email/domain";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-cold-email-tools");

export async function adminColdEmailGetSettings(
  ctx: McpToolContext,
  _params: unknown,
): Promise<McpResult<ColdEmailSettings>> {
  const started = Date.now();
  logger.info("tool:admin_cold_email_get_settings", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  try {
    const data = await getColdEmailSettings({
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    });
    logger.info("tool:admin_cold_email_get_settings ok", {
      durationMs: Date.now() - started,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminColdEmailUpdateSettings(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<ColdEmailSettings>> {
  const started = Date.now();
  logger.info("tool:admin_cold_email_update_settings", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = coldEmailUpdateSettingsBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError(
        "Invalid input for admin_cold_email_update_settings",
        { issues: parsed.error.issues },
      ),
    );
  }
  try {
    const data = await updateColdEmailSettings(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    logger.info("tool:admin_cold_email_update_settings ok", {
      durationMs: Date.now() - started,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
