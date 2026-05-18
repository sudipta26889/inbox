import prisma from "@/utils/prisma";
import { DEFAULT_PROVIDER } from "@/utils/llms/config";
import { NotFoundError, ValidationError } from "@/utils/mcp-server/errors";
import { isAllowedProvider } from "./allowed-models";

export interface UpdateAiSettingsInput {
  aiModel: string;
  aiProvider: string;
}

export interface UpdateAiSettingsResult {
  aiModel: string | null;
  aiProvider: string | null;
}

export async function updateAiSettings(
  ctx: { userId: string },
  input: UpdateAiSettingsInput,
): Promise<UpdateAiSettingsResult> {
  if (!isAllowedProvider(input.aiProvider)) {
    throw new ValidationError(`Invalid AI provider: ${input.aiProvider}`, {
      aiProvider: input.aiProvider,
    });
  }

  const isDefault = input.aiProvider === DEFAULT_PROVIDER;
  // Note: data is deliberately limited to aiProvider + aiModel. The stored
  // aiApiKey is preserved across MCP-driven updates (spec §2 non-goal).
  const data = isDefault
    ? { aiProvider: null, aiModel: null }
    : { aiProvider: input.aiProvider, aiModel: input.aiModel };

  const result = await prisma.user.updateMany({
    where: { id: ctx.userId },
    data,
  });

  if (result.count === 0)
    throw new NotFoundError(`User not found: ${ctx.userId}`);

  return {
    aiProvider: data.aiProvider,
    aiModel: data.aiModel,
  };
}
