"use server";

import {
  setNewsletterStatusBody,
  unsubscribeSenderBody,
} from "@/utils/actions/unsubscriber.validation";
import { actionClient } from "@/utils/actions/safe-action";
import { SafeError } from "@/utils/error";
import { setSenderStatus } from "@/utils/senders/unsubscribe";
import { requestUnsubscribe } from "@/utils/unsubscriber/domain";

export const setNewsletterStatusAction = actionClient
  .metadata({ name: "setNewsletterStatus" })
  .inputSchema(setNewsletterStatusBody)
  .action(
    async ({
      parsedInput: { newsletterEmail, status },
      ctx: { emailAccountId },
    }) => {
      return setSenderStatus({
        emailAccountId,
        newsletterEmail,
        status,
      });
    },
  );

export const unsubscribeSenderAction = actionClient
  .metadata({ name: "unsubscribeSender" })
  .inputSchema(unsubscribeSenderBody)
  .action(
    async ({
      parsedInput: { newsletterEmail, unsubscribeLink, listUnsubscribeHeader },
      ctx: { userId, emailAccountId, logger },
    }) => {
      try {
        const result = await requestUnsubscribe(
          { userId, emailAccountId, logger },
          {
            newsletterEmail,
            unsubscribeLink,
            listUnsubscribeHeader,
            confirm: true,
          },
        );
        if (result.dryRun) {
          throw new SafeError("Unexpected dry-run result");
        }
        return result.data;
      } catch (error) {
        if (error instanceof SafeError) throw error;
        if (error instanceof Error) throw new SafeError(error.message);
        throw new SafeError("Failed to unsubscribe");
      }
    },
  );
