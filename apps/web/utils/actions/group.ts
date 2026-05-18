"use server";

import { z } from "zod";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import {
  addGroupItemBody,
  createGroupBody,
} from "@/utils/actions/group.validation";
import {
  addGroupItem as addGroupItemDomain,
  createGroup as createGroupDomain,
  removeGroupItem as removeGroupItemDomain,
} from "@/utils/group/group-domain";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
} from "@/utils/mcp-server/errors";

function rethrow(e: unknown): never {
  if (
    e instanceof NotFoundError ||
    e instanceof ForbiddenError ||
    e instanceof ConflictError
  ) {
    throw new SafeError(e.message);
  }
  throw e;
}

export const createGroupAction = actionClient
  .metadata({ name: "createGroup" })
  .inputSchema(createGroupBody)
  .action(async ({ ctx: { userId, emailAccountId }, parsedInput }) => {
    try {
      return await createGroupDomain({ userId, emailAccountId }, parsedInput);
    } catch (e) {
      rethrow(e);
    }
  });

export const addGroupItemAction = actionClient
  .metadata({ name: "addGroupItem" })
  .inputSchema(addGroupItemBody)
  .action(async ({ ctx: { userId, emailAccountId }, parsedInput }) => {
    try {
      return await addGroupItemDomain({ userId, emailAccountId }, parsedInput);
    } catch (e) {
      rethrow(e);
    }
  });

export const deleteGroupItemAction = actionClient
  .metadata({ name: "deleteGroupItem" })
  .inputSchema(z.object({ id: z.string() }))
  .action(async ({ ctx: { userId, emailAccountId }, parsedInput: { id } }) => {
    try {
      return await removeGroupItemDomain(
        { userId, emailAccountId },
        { itemId: id },
      );
    } catch (e) {
      rethrow(e);
    }
  });
