import { decryptToken } from "@/utils/encryption";
import prisma from "@/utils/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { TaskpilotNotConfiguredError } from "@/utils/taskpilot/errors";

export interface TaskpilotConfig {
  apiKey: string;
  workspaceSlug: string;
}

export async function getTaskpilotConfigForUser(
  userId: string,
): Promise<TaskpilotConfig> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { taskpilotApiKey: true, taskpilotWorkspaceSlug: true },
  });
  if (!user?.taskpilotApiKey || !user.taskpilotWorkspaceSlug) {
    throw new TaskpilotNotConfiguredError();
  }
  const apiKey = decryptToken(user.taskpilotApiKey);
  if (!apiKey) {
    throw new TaskpilotNotConfiguredError(
      "Failed to decrypt TaskPilot API key",
    );
  }
  return { apiKey, workspaceSlug: user.taskpilotWorkspaceSlug };
}

export async function getTaskpilotClientForUser(
  userId: string,
): Promise<TaskpilotClient> {
  const cfg = await getTaskpilotConfigForUser(userId);
  return new TaskpilotClient(cfg);
}

export async function getTaskpilotConfigStatus(
  userId: string,
): Promise<{ configured: boolean; workspaceSlug: string | null }> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { taskpilotApiKey: true, taskpilotWorkspaceSlug: true },
  });
  return {
    configured: Boolean(user?.taskpilotApiKey && user.taskpilotWorkspaceSlug),
    workspaceSlug: user?.taskpilotWorkspaceSlug ?? null,
  };
}
