import {
  type AccountProfile,
  getAccountProfile,
  updateAccountProfile,
  updateAccountProfileSchema,
} from "@/utils/account/account";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import { z } from "zod";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-account-tools");

const adminAccountGetInput = z.object({}).strict();

export async function adminAccountGet(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<AccountProfile>> {
  const started = Date.now();
  logger.info("tool:admin_account_get", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  const parsed = adminAccountGetInput.safeParse(params ?? {});
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for admin_account_get", {
        issues: parsed.error.issues,
      }),
    );
  }

  try {
    const data = await getAccountProfile({
      userId: context.userId,
      emailAccountId: context.emailAccountId,
    });
    logger.info("tool:admin_account_get ok", {
      durationMs: Date.now() - started,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminAccountUpdate(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<AccountProfile>> {
  const started = Date.now();
  logger.info("tool:admin_account_update", {
    userId: context.userId,
    emailAccountId: context.emailAccountId,
  });

  const parsed = updateAccountProfileSchema.safeParse(params);
  if (!parsed.success) {
    // Surface the offending keys (if any) so audit logs / clients can see
    // which excluded field was rejected. The strict() schema produces
    // `unrecognized_keys` issues whose `keys` array names each forbidden field.
    const offendingKeys = parsed.error.issues
      .filter((i) => i.code === "unrecognized_keys")
      .flatMap((i) => (i as { keys?: string[] }).keys ?? []);
    if (offendingKeys.length > 0) {
      logger.warn("admin_account_update rejected excluded field(s)", {
        userId: context.userId,
        offending: offendingKeys,
      });
    }
    return mapDomainError(
      new ValidationError("Invalid input for admin_account_update", {
        issues: parsed.error.issues,
        ...(offendingKeys.length > 0 ? { offendingKeys } : {}),
      }),
    );
  }

  try {
    const data = await updateAccountProfile(
      { userId: context.userId, emailAccountId: context.emailAccountId },
      parsed.data,
    );
    logger.info("tool:admin_account_update ok", {
      durationMs: Date.now() - started,
      fields: Object.keys(parsed.data),
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
