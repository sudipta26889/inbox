import {
  ALLOWED_AI_PROVIDERS,
  type AllowedAiProvider,
} from "@/utils/ai-settings/allowed-models";
import {
  getAiSettings,
  type GetAiSettingsResult,
} from "@/utils/ai-settings/get-ai-settings";
import {
  updateAiSettings,
  type UpdateAiSettingsResult,
} from "@/utils/ai-settings/update-ai-settings";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import { z } from "zod";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-ai-tools");

/**
 * Field names that look like credentials and must never appear in an
 * admin_ai_update_model payload. The strict() schema below would also reject
 * unknown keys, but this explicit pre-parse guard emits a dedicated audit
 * signal so log review can surface attempted credential injection
 * unambiguously.
 */
const FORBIDDEN_KEY_NAMES = [
  "aiApiKey",
  "apiKey",
  "api_key",
  "secret",
  "token",
  "key",
  "credentials",
  "credential",
  "password",
] as const;

const adminAiUpdateModelInput = z
  .object({
    aiProvider: z.enum(
      ALLOWED_AI_PROVIDERS as unknown as [
        AllowedAiProvider,
        ...AllowedAiProvider[],
      ],
    ),
    aiModel: z.string(),
  })
  .strict();

export async function adminAiGetSettings(
  context: McpToolContext,
  _params: unknown,
): Promise<McpResult<GetAiSettingsResult>> {
  const started = Date.now();
  logger.info("tool:admin_ai_get_settings", { userId: context.userId });
  try {
    const data = await getAiSettings({ userId: context.userId });
    logger.info("tool:admin_ai_get_settings ok", {
      durationMs: Date.now() - started,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminAiUpdateModel(
  context: McpToolContext,
  params: unknown,
): Promise<McpResult<UpdateAiSettingsResult>> {
  const started = Date.now();
  logger.info("tool:admin_ai_update_model", { userId: context.userId });

  // Explicit pre-parse credential-name guard. The .strict() schema below would
  // also reject these keys with a generic Zod error, but this branch emits a
  // dedicated audit signal (details.reason = "api_key_field_rejected") so log
  // review can surface attempted credential injection unambiguously.
  if (params && typeof params === "object" && !Array.isArray(params)) {
    const provided = Object.keys(params as Record<string, unknown>);
    const offending = provided.filter((k) =>
      (FORBIDDEN_KEY_NAMES as readonly string[]).some(
        (forbidden) => k.toLowerCase() === forbidden.toLowerCase(),
      ),
    );
    if (offending.length > 0) {
      logger.warn("admin_ai_update_model rejected API-key-shaped field", {
        userId: context.userId,
        offending,
      });
      return mapDomainError(
        new ValidationError(
          "API key, secret, and token fields are not accepted by this tool.",
          { reason: "api_key_field_rejected", fields: offending },
        ),
      );
    }
  }

  const parsed = adminAiUpdateModelInput.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input for admin_ai_update_model", {
        issues: parsed.error.issues,
      }),
    );
  }

  try {
    const data = await updateAiSettings(
      { userId: context.userId },
      { aiProvider: parsed.data.aiProvider, aiModel: parsed.data.aiModel },
    );
    logger.info("tool:admin_ai_update_model ok", {
      durationMs: Date.now() - started,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
