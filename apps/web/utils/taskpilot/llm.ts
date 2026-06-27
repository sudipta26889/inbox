import type { EnrichmentInput } from "@/utils/ai/taskpilot/enrich";
import { createGenerateObject } from "@/utils/llms";
import { getModel } from "@/utils/llms/model";
import { NotFoundError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";

const TASKPILOT_SYSTEM =
  "You are a strict JSON generator. Output JSON only that matches the provided schema.";

export async function buildTaskpilotChatCompletion(
  emailAccountId: string,
): Promise<NonNullable<EnrichmentInput["chatCompletionObject"]>> {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      id: true,
      email: true,
      userId: true,
      user: {
        select: { aiProvider: true, aiModel: true, aiApiKey: true },
      },
    },
  });
  if (!emailAccount) {
    throw new NotFoundError("Email account not found");
  }

  const modelOptions = getModel(emailAccount.user, "chat");
  const generate = createGenerateObject({
    emailAccount,
    label: "taskpilot-enrich",
    modelOptions,
  });

  return async ({ prompt, schema }) => {
    const result = await generate({
      ...modelOptions,
      system: TASKPILOT_SYSTEM,
      prompt,
      schema,
    });
    return { object: result.object };
  };
}
