"use server";

import prisma from "@/utils/prisma";
import {
  createKnowledgeBody,
  deleteKnowledgeBody,
  updateKnowledgeBody,
} from "@/utils/actions/knowledge.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import {
  KNOWLEDGE_BASIC_MAX_CHARS,
  KNOWLEDGE_BASIC_MAX_ITEMS,
} from "@/utils/config";
import { PremiumTier } from "@/generated/prisma/enums";
import { checkHasAccess } from "@/utils/premium/server";
import {
  createKnowledge,
  deleteKnowledge,
  updateKnowledge,
} from "@/utils/knowledge/knowledge";
import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";

function toSafeError(e: unknown): never {
  if (e instanceof ConflictError) throw new SafeError(e.message);
  if (e instanceof NotFoundError) throw new SafeError("Item not found");
  throw e;
}

export const createKnowledgeAction = actionClient
  .metadata({ name: "createKnowledge" })
  .inputSchema(createKnowledgeBody)
  .action(async ({ ctx: { emailAccountId, userId }, parsedInput }) => {
    const knowledgeCount = await prisma.knowledge.count({
      where: { emailAccountId },
    });

    // premium check
    if (
      knowledgeCount >= KNOWLEDGE_BASIC_MAX_ITEMS ||
      parsedInput.content.length > KNOWLEDGE_BASIC_MAX_CHARS
    ) {
      const hasAccess = await checkHasAccess({
        userId,
        minimumTier: PremiumTier.PLUS_MONTHLY,
      });

      if (!hasAccess) {
        throw new SafeError(
          `You can save up to ${KNOWLEDGE_BASIC_MAX_CHARS} characters and ${KNOWLEDGE_BASIC_MAX_ITEMS} item to your knowledge base. Upgrade to a higher tier to save unlimited content.`,
        );
      }
    }

    try {
      await createKnowledge({ userId, emailAccountId }, parsedInput);
    } catch (e) {
      toSafeError(e);
    }
  });

export const updateKnowledgeAction = actionClient
  .metadata({ name: "updateKnowledge" })
  .inputSchema(updateKnowledgeBody)
  .action(async ({ ctx: { emailAccountId, userId }, parsedInput }) => {
    if (parsedInput.content.length > KNOWLEDGE_BASIC_MAX_CHARS) {
      const hasAccess = await checkHasAccess({
        userId,
        minimumTier: PremiumTier.PLUS_MONTHLY,
      });

      if (!hasAccess) {
        throw new SafeError(
          `You can save up to ${KNOWLEDGE_BASIC_MAX_CHARS} characters to your knowledge base. Upgrade to a higher tier to save unlimited content.`,
        );
      }
    }

    try {
      await updateKnowledge({ userId, emailAccountId }, parsedInput);
    } catch (e) {
      toSafeError(e);
    }
  });

export const deleteKnowledgeAction = actionClient
  .metadata({ name: "deleteKnowledge" })
  .inputSchema(deleteKnowledgeBody)
  .action(async ({ ctx: { emailAccountId, userId }, parsedInput }) => {
    try {
      await deleteKnowledge({ userId, emailAccountId }, parsedInput);
    } catch (e) {
      // Stay silent on NotFound to match prior behavior of
      // `prisma.knowledge.delete({ where: { id, emailAccountId } })`
      // which would simply throw and be swallowed by the action layer.
      if (e instanceof NotFoundError) return;
      toSafeError(e);
    }
  });
