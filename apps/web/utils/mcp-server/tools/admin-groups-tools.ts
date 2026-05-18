import type { ZodSchema } from "zod";
import { createScopedLogger } from "@/utils/logger";
import {
  addGroupItemBody,
  createGroupBody,
  deleteGroupBody,
  getGroupBody,
  removeGroupItemBody,
  updateGroupBody,
} from "@/utils/actions/group.validation";
import {
  addGroupItem,
  createGroup,
  deleteGroup,
  getGroup,
  listGroups,
  previewGroupDeletion,
  removeGroupItem,
  updateGroup,
} from "@/utils/group/group-domain";
import { mapDomainError } from "@/utils/mcp-server/error-mapper";
import { withDryRunGate } from "@/utils/mcp-server/dry-run";
import type { McpResult } from "@/utils/mcp-server/envelope";
import { ValidationError } from "@/utils/mcp-server/errors";
import type { McpToolContext } from "./registry";

const logger = createScopedLogger("mcp-admin-groups");

function parseOr<T>(schema: ZodSchema<T>, params: unknown): T {
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    throw new ValidationError("Invalid input", { issues: parsed.error.issues });
  }
  return parsed.data;
}

export async function adminGroupsList(
  ctx: McpToolContext,
  _params: unknown,
): Promise<McpResult<unknown>> {
  try {
    logger.info("admin_groups_list", { emailAccountId: ctx.emailAccountId });
    const data = await listGroups({
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    });
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsGet(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(getGroupBody, params);
    logger.info("admin_groups_get", {
      emailAccountId: ctx.emailAccountId,
      groupId: input.groupId,
    });
    const data = await getGroup(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      input,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsCreate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(createGroupBody, params);
    logger.info("admin_groups_create", {
      emailAccountId: ctx.emailAccountId,
      ruleId: input.ruleId,
    });
    const data = await createGroup(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      input,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsUpdate(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(updateGroupBody, params);
    logger.info("admin_groups_update", {
      emailAccountId: ctx.emailAccountId,
      groupId: input.groupId,
    });
    const data = await updateGroup(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      input,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsDelete(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(deleteGroupBody, params);
    const domainCtx = {
      userId: ctx.userId,
      emailAccountId: ctx.emailAccountId,
    };
    logger.info("admin_groups_delete", {
      emailAccountId: ctx.emailAccountId,
      groupId: input.groupId,
      confirm: input.confirm,
    });

    return await withDryRunGate({
      confirm: input.confirm,
      preview: () =>
        previewGroupDeletion(domainCtx, { groupId: input.groupId }),
      commit: () => deleteGroup(domainCtx, input),
    });
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsAddItem(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(addGroupItemBody, params);
    logger.info("admin_groups_add_item", {
      emailAccountId: ctx.emailAccountId,
      groupId: input.groupId,
    });
    const data = await addGroupItem(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      input,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}

export async function adminGroupsRemoveItem(
  ctx: McpToolContext,
  params: unknown,
): Promise<McpResult<unknown>> {
  try {
    const input = parseOr(removeGroupItemBody, params);
    logger.info("admin_groups_remove_item", {
      emailAccountId: ctx.emailAccountId,
      itemId: input.itemId,
    });
    const data = await removeGroupItem(
      { userId: ctx.userId, emailAccountId: ctx.emailAccountId },
      input,
    );
    return { ok: true, data };
  } catch (e) {
    return mapDomainError(e);
  }
}
