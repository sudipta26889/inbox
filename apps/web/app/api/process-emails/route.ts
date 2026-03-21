import { withError } from "@/utils/middleware";
import { withQstashOrInternal } from "@/utils/qstash";
import { z } from "zod";
import { processEmailsForAccount } from "./process-account";

export const maxDuration = 300;

const processEmailsPayloadSchema = z.object({
  emailAccountId: z.string().min(1),
});

export const POST = withError(
  "process-emails",
  withQstashOrInternal(async (request) => {
    const logger = request.logger;

    const rawPayload = await request.json();
    const validation = processEmailsPayloadSchema.safeParse(rawPayload);

    if (!validation.success) {
      logger.error("Invalid process emails payload", {
        errors: validation.error.errors,
      });
      return new Response("Invalid payload", { status: 400 });
    }

    const { emailAccountId } = validation.data;
    const runLogger = logger.with({ emailAccountId });

    const result = await processEmailsForAccount({
      emailAccountId,
      logger: runLogger,
    });

    runLogger.info("Finished process emails for account", { result });

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
);
