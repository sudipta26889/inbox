"use server";

import { after } from "next/server";
import { actionClient } from "@/utils/actions/safe-action";
import prisma from "@/utils/prisma";
import { schedulePersonaAnalysis } from "@/utils/ai/knowledge/analyze-persona";
import { createEmailProvider } from "@/utils/email/provider";
import { updateContactRole } from "@inboxzero/loops";
import {
  shareEmailAccountBody,
  unshareEmailAccountBody,
  updateHiddenAiDraftLinksBody,
  updateReferralSignatureBody,
  updateSentWithSignatureBody,
  updateSentMessageOpenTrackingBody,
} from "@/utils/actions/email-account.validation";
import { SafeError } from "@/utils/error";
import { invalidateAccountValidation } from "@/utils/redis/account-validation";
import { z } from "zod";

export const updateEmailAccountRoleAction = actionClient
  .metadata({ name: "updateEmailAccountRole" })
  .inputSchema(
    z.object({
      role: z.string(),
      writeOnboardingAnswers: z.boolean().optional().default(true),
    }),
  )
  .action(
    async ({
      ctx: { emailAccountId, userEmail, userId, logger },
      parsedInput: { role, writeOnboardingAnswers },
    }) => {
      await prisma.$transaction([
        prisma.emailAccount.update({
          where: { id: emailAccountId },
          data: { role },
        }),
        prisma.user.update({
          where: { id: userId },
          data: {
            ...(writeOnboardingAnswers
              ? { onboardingAnswers: { answers: { role } } }
              : {}),
            surveyRole: role,
          },
        }),
      ]);

      after(async () => {
        await updateContactRole({
          email: userEmail,
          role,
        }).catch((error) => {
          logger.error("Loops: Error updating role", { error });
        });
      });
    },
  );

export const analyzePersonaAction = actionClient
  .metadata({ name: "analyzePersona" })
  .action(async ({ ctx: { emailAccountId, provider, logger } }) =>
    schedulePersonaAnalysis({ emailAccountId, provider, logger }),
  );

export const updateReferralSignatureAction = actionClient
  .metadata({ name: "updateReferralSignature" })
  .inputSchema(updateReferralSignatureBody)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { enabled } }) => {
      logger.info("Updating referral signature", { enabled });

      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { includeReferralSignature: enabled },
      });
    },
  );

export const updateSentWithSignatureAction = actionClient
  .metadata({ name: "updateSentWithSignature" })
  .inputSchema(updateSentWithSignatureBody)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { enabled } }) => {
      logger.info("Updating sent with signature", { enabled });

      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { includeSentWithSignature: enabled },
      });
    },
  );

export const updateHiddenAiDraftLinksAction = actionClient
  .metadata({ name: "updateHiddenAiDraftLinks" })
  .inputSchema(updateHiddenAiDraftLinksBody)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { enabled } }) => {
      logger.info("Updating hidden AI draft links", { enabled });

      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { allowHiddenAiDraftLinks: enabled },
      });
    },
  );

export const updateSentMessageOpenTrackingAction = actionClient
  .metadata({ name: "updateSentMessageOpenTracking" })
  .inputSchema(updateSentMessageOpenTrackingBody)
  .action(
    async ({ ctx: { emailAccountId, logger }, parsedInput: { enabled } }) => {
      logger.info("Updating sent message open tracking", { enabled });

      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { sentMessageOpenTrackingEnabled: enabled },
      });
    },
  );

export const fetchSignaturesFromProviderAction = actionClient
  .metadata({ name: "fetchSignaturesFromProvider" })
  .action(async ({ ctx: { emailAccountId, provider, logger } }) => {
    const emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });

    const signatures = await emailProvider.getSignatures();

    return { signatures };
  });

export const shareEmailAccountAction = actionClient
  .metadata({ name: "shareEmailAccount" })
  .inputSchema(shareEmailAccountBody)
  .action(async ({ ctx: { emailAccountId, userId, session }, parsedInput }) => {
    assertAccountOwner({ ownerUserId: userId, sessionUserId: session.user.id });

    // Match the login email, or any account the user has connected.
    const target = await prisma.user.findFirst({
      where: {
        OR: [
          { email: parsedInput.email },
          { emailAccounts: { some: { email: parsedInput.email } } },
        ],
      },
      select: { id: true },
    });

    if (!target) {
      throw new SafeError(
        "No user found with that email. They need to sign in once first.",
      );
    }
    if (target.id === userId) {
      throw new SafeError("You already own this account.");
    }

    await prisma.emailAccountShare.upsert({
      where: {
        emailAccountId_userId: { emailAccountId, userId: target.id },
      },
      create: { emailAccountId, userId: target.id },
      update: {},
    });
    await invalidateAccountValidation({
      userId: target.id,
      emailAccountId,
    });
  });

export const unshareEmailAccountAction = actionClient
  .metadata({ name: "unshareEmailAccount" })
  .inputSchema(unshareEmailAccountBody)
  .action(async ({ ctx: { emailAccountId, userId, session }, parsedInput }) => {
    assertAccountOwner({ ownerUserId: userId, sessionUserId: session.user.id });

    await prisma.emailAccountShare.deleteMany({
      where: { emailAccountId, userId: parsedInput.userId },
    });
    await invalidateAccountValidation({
      userId: parsedInput.userId,
      emailAccountId,
    });
  });

function assertAccountOwner({
  ownerUserId,
  sessionUserId,
}: {
  ownerUserId: string;
  sessionUserId: string;
}) {
  if (ownerUserId !== sessionUserId) {
    throw new SafeError("Only the account owner can manage sharing.");
  }
}
