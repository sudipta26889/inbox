import { handleCallback } from "@vercel/queue";
import { z } from "zod";
import { captureException } from "@/utils/error";
import { createScopedLogger } from "@/utils/logger";
import { getQueueRetryBackoffSeconds } from "@/utils/queue/retry";
import { processEmailsForAccount } from "../process-account";

export const maxDuration = 300;

const logger = createScopedLogger("process-emails/queue");

const queuePayloadSchema = z.object({
  emailAccountId: z.string().min(1),
});

export const POST = handleCallback<z.infer<typeof queuePayloadSchema>>(
  async (message, metadata) => {
    const parseResult = queuePayloadSchema.safeParse(message);
    if (!parseResult.success) {
      logger.error("Invalid process emails queue payload", {
        errors: parseResult.error.errors,
        queueMessageId: metadata.messageId,
      });
      return;
    }

    const { emailAccountId } = parseResult.data;
    const runLogger = logger.with({
      emailAccountId,
      queueMessageId: metadata.messageId,
      deliveryCount: metadata.deliveryCount,
    });

    try {
      const result = await processEmailsForAccount({
        emailAccountId,
        logger: runLogger,
      });

      runLogger.info("Finished queued process emails account task", {
        result,
      });
    } catch (error) {
      runLogger.error("Failed queued process emails account task", {
        error,
      });
      captureException(error);
      throw error;
    }
  },
  {
    visibilityTimeoutSeconds: 280,
    retry: (_error, metadata) => {
      return {
        afterSeconds: getQueueRetryBackoffSeconds({
          deliveryCount: metadata.deliveryCount,
        }),
      };
    },
  },
);
