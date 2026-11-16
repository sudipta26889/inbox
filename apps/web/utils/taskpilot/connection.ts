import type { TaskpilotClient } from "@/utils/taskpilot/client";

export type TaskpilotConnectionResult = {
  ok: true;
  projectCount: number;
  /**
   * Present only when a project is pinned. `ok` is whether the pinned project
   * is in the workspace's project list, the same rule the router uses.
   */
  pin: { projectId: string; ok: boolean } | null;
};

/**
 * Checks the token and workspace, and, when a project is pinned, that the pin
 * is one of the workspace's projects. A missing pin is reported rather than
 * thrown: the connection works, but Inbox would do nothing.
 */
export async function checkTaskpilotConnection(
  client: TaskpilotClient,
  projectId: string | null,
): Promise<TaskpilotConnectionResult> {
  const projects = await client.listProjects();

  return {
    ok: true,
    projectCount: projects.length,
    pin: projectId
      ? { projectId, ok: projects.some((p) => p.id === projectId) }
      : null,
  };
}
