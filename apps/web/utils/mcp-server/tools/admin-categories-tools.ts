import { createScopedLogger } from "@/utils/logger";
import {
  createCategory,
  deleteCategory,
  listCategories,
  previewDeleteCategory,
  updateCategory,
} from "@/utils/categories/categories";
import {
  createCategoryBody,
  deleteCategoryBody,
  updateCategoryBody,
} from "@/utils/categories/validation";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { ValidationError } from "@/utils/mcp-server/errors";
import { withDryRunGate } from "@/utils/mcp-server/dry-run";
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

export async function adminCategoriesUpdate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ category: unknown }>> {
  logger.info("MCP tool: admin_categories_update", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = updateCategoryBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await updateCategory(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminCategoriesCreate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<{ category: unknown }>> {
  logger.info("MCP tool: admin_categories_create", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = createCategoryBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  try {
    const data = await createCategory(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      parsed.data,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminCategoriesDelete(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  logger.info("MCP tool: admin_categories_delete", {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  });
  const parsed = deleteCategoryBody.safeParse(params);
  if (!parsed.success) {
    return mapDomainError(
      new ValidationError("Invalid input", { issues: parsed.error.issues }),
    );
  }
  const { categoryId, confirm } = parsed.data;
  const domainCtx = {
    userId: ctx.userId,
    emailAccountId: ctx.emailAccountId,
  };

  try {
    return await withDryRunGate({
      confirm,
      preview: async () => {
        const p = await previewDeleteCategory(domainCtx, { categoryId });
        return {
          action: "delete_category",
          category: p.category,
          willCascade: { detachSenders: p.affectedSenders },
          irreversible: true,
        };
      },
      commit: async () => {
        return await deleteCategory(domainCtx, { categoryId });
      },
    });
  } catch (e) {
    return mapDomainError(e);
  }
}
