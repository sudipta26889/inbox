"use server";

import { actionClient } from "@/utils/actions/safe-action";
import {
  saveAiSettingsBody,
  saveEmailUpdateSettingsBody,
  saveDigestScheduleBody,
  updateDigestItemsBody,
  toggleDigestBody,
} from "@/utils/actions/settings.validation";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";
import prisma from "@/utils/prisma";
import {
  calculateNextScheduleDate,
  createCanonicalTimeOfDay,
} from "@/utils/schedule";
import { actionClientUser } from "@/utils/actions/safe-action";
import { ActionType, SystemType } from "@/generated/prisma/enums";
import { clearSpecificErrorMessages, ErrorType } from "@/utils/error-messages";
import { SafeError } from "@/utils/error";
import { env } from "@/env";
import { updateDigestItems, updateDigestSchedule } from "@/utils/digest/domain";
import { updateAiSettings } from "@/utils/ai-settings/update-ai-settings";
import { NotFoundError } from "@/utils/mcp-server/errors";

export const updateEmailSettingsAction = actionClient
  .metadata({ name: "updateEmailSettings" })
  .inputSchema(saveEmailUpdateSettingsBody)
  .action(
    async ({
      ctx: { emailAccountId },
      parsedInput: { statsEmailFrequency, summaryEmailFrequency },
    }) => {
      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: {
          statsEmailFrequency,
          summaryEmailFrequency,
        },
      });
    },
  );

export const updateAiSettingsAction = actionClientUser
  .metadata({ name: "updateAiSettings" })
  .inputSchema(saveAiSettingsBody)
  .action(
    async ({
      ctx: { userId, logger },
      parsedInput: { aiProvider, aiModel, aiApiKey },
    }) => {
      if (aiProvider === Provider.AZURE && !env.AZURE_RESOURCE_NAME) {
        throw new Error(
          "Azure provider requires AZURE_RESOURCE_NAME to be configured on the server",
        );
      }

      try {
        await updateAiSettings({ userId }, { aiProvider, aiModel });
      } catch (e) {
        if (e instanceof NotFoundError) {
          throw new SafeError("User not found");
        }
        throw e;
      }

      // Preserve the existing aiApiKey write behavior for the web UI: the form
      // sends `aiApiKey: undefined` when the user clears it. The MCP path does
      // not call this action and never touches aiApiKey.
      await prisma.user.update({
        where: { id: userId },
        data:
          aiProvider === DEFAULT_PROVIDER
            ? { aiApiKey: null }
            : { aiApiKey: aiApiKey ?? null },
      });

      // Clear AI-related error messages when user updates their settings
      // This allows them to be notified again if the new settings are also invalid
      await clearSpecificErrorMessages({
        userId,
        errorTypes: [
          ErrorType.INCORRECT_API_KEY,
          ErrorType.INVALID_AI_MODEL,
          ErrorType.API_KEY_DEACTIVATED,
          ErrorType.AI_QUOTA_ERROR,
          ErrorType.INSUFFICIENT_CREDITS,
          // Legacy keys for old stored errors
          ErrorType.INCORRECT_OPENAI_API_KEY,
          ErrorType.OPENAI_API_KEY_DEACTIVATED,
          ErrorType.ANTHROPIC_INSUFFICIENT_BALANCE,
        ],
        logger,
      });
    },
  );

export const updateDigestScheduleAction = actionClient
  .metadata({ name: "updateDigestSchedule" })
  .inputSchema(saveDigestScheduleBody)
  .action(async ({ ctx: { emailAccountId, userId }, parsedInput }) => {
    await updateDigestSchedule({ userId, emailAccountId }, parsedInput);
    return { success: true };
  });

export const updateDigestItemsAction = actionClient
  .metadata({ name: "updateDigestItems" })
  .inputSchema(updateDigestItemsBody)
  .action(async ({ ctx: { emailAccountId, userId, logger }, parsedInput }) => {
    const result = await updateDigestItems(
      { userId, emailAccountId },
      parsedInput,
    );
    if (result.failureCount > 0) {
      logger.warn("updateDigestItems partial failure", {
        successCount: result.successCount,
        failureCount: result.failureCount,
      });
    }
    return { success: true, ...result };
  });

export const toggleDigestAction = actionClient
  .metadata({ name: "toggleDigest" })
  .inputSchema(toggleDigestBody)
  .action(
    async ({
      ctx: { emailAccountId },
      parsedInput: { enabled, timeOfDay },
    }) => {
      if (enabled) {
        const defaultSchedule = {
          intervalDays: 1,
          occurrences: 1,
          daysOfWeek: 127,
          timeOfDay: timeOfDay ?? createCanonicalTimeOfDay(9, 0),
        };

        await prisma.schedule.upsert({
          where: { emailAccountId },
          create: {
            emailAccountId,
            ...defaultSchedule,
            lastOccurrenceAt: new Date(),
            nextOccurrenceAt: calculateNextScheduleDate({
              ...defaultSchedule,
              lastOccurrenceAt: null,
            }),
          },
          update: {},
        });

        const newsletterRule = await prisma.rule.findFirst({
          where: { emailAccountId, systemType: SystemType.NEWSLETTER },
          include: { actions: true },
        });

        if (
          newsletterRule &&
          !newsletterRule.actions.some((a) => a.type === ActionType.DIGEST)
        ) {
          await prisma.action.create({
            data: { ruleId: newsletterRule.id, type: ActionType.DIGEST },
          });
        }
      } else {
        await prisma.schedule.deleteMany({
          where: { emailAccountId },
        });
      }

      return { success: true };
    },
  );
