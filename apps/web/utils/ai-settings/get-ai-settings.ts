import prisma from "@/utils/prisma";
import { NotFoundError } from "@/utils/mcp-server/errors";
import {
  ALLOWED_AI_PROVIDERS,
  getProviderOptionsForMcp,
} from "./allowed-models";

export interface GetAiSettingsResult {
  aiModel: string | null;
  aiProvider: string | null;
  allowedProviders: ReadonlyArray<string>;
  providerOptions: Array<{ label: string; value: string }>;
}

export async function getAiSettings(ctx: {
  userId: string;
}): Promise<GetAiSettingsResult> {
  const user = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: {
      aiProvider: true,
      aiModel: true,
      // Deliberately NOT selecting aiApiKey. Spec §2 non-goal.
    },
  });

  if (!user) throw new NotFoundError(`User not found: ${ctx.userId}`);

  return {
    aiProvider: user.aiProvider,
    aiModel: user.aiModel,
    allowedProviders: ALLOWED_AI_PROVIDERS,
    providerOptions: getProviderOptionsForMcp(),
  };
}
