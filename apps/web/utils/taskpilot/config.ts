import { decryptToken } from "@/utils/encryption";
import prisma from "@/utils/prisma";
import { TaskpilotClient } from "@/utils/taskpilot/client";
import { TaskpilotNotConfiguredError } from "@/utils/taskpilot/errors";

export interface TaskpilotConfig {
  apiKey: string;
  /** When set, Inbox reads and writes TaskPilot work only in this project. */
  projectId: string | null;
  workspaceSlug: string;
}

export async function getTaskpilotConfigForUser(
  userId: string,
): Promise<TaskpilotConfig> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      taskpilotApiKey: true,
      taskpilotWorkspaceSlug: true,
      taskpilotProjectId: true,
    },
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
  return {
    apiKey,
    workspaceSlug: user.taskpilotWorkspaceSlug,
    projectId: user.taskpilotProjectId ?? null,
  };
}

export async function getTaskpilotClientForUser(
  userId: string,
): Promise<TaskpilotClient> {
  const cfg = await getTaskpilotConfigForUser(userId);
  return new TaskpilotClient(cfg);
}

export async function getTaskpilotConfigStatus(userId: string): Promise<{
  configured: boolean;
  projectId: string | null;
  workspaceSlug: string | null;
}> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      taskpilotApiKey: true,
      taskpilotWorkspaceSlug: true,
      taskpilotProjectId: true,
    },
  });
  return {
    configured: Boolean(user?.taskpilotApiKey && user.taskpilotWorkspaceSlug),
    projectId: user?.taskpilotProjectId ?? null,
    workspaceSlug: user?.taskpilotWorkspaceSlug ?? null,
  };
}
