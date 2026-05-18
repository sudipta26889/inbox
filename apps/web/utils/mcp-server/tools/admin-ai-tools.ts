import {
  getAiSettings,
  type GetAiSettingsResult,
} from "@/utils/ai-settings/get-ai-settings";
import { createScopedLogger } from "@/utils/logger";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-ai-tools");

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
