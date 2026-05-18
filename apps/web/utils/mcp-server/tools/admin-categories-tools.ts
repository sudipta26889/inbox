import { createScopedLogger } from "@/utils/logger";
import { listCategories } from "@/utils/categories/categories";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import type { McpResult } from "@/utils/mcp-server/envelope";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-categories-tools");

export async function adminCategoriesList(
  ctx: McpToolContext,
  _params: unknown,
): Promise<McpResult<{ categories: unknown[] }>> {
  logger.info("MCP tool: admin_categories_list", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  try {
    const data = await listCategories({
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
