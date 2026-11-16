import { describe, expect, it, vi } from "vitest";
import { checkTaskpilotConnection } from "@/utils/taskpilot/connection";
import type { TaskpilotClient } from "@/utils/taskpilot/client";

function clientWith(projectIds: string[]) {
  return {
    listProjects: vi.fn().mockResolvedValue(projectIds.map((id) => ({ id }))),
  } as unknown as TaskpilotClient;
}

describe("checkTaskpilotConnection", () => {
  it("reports no pin when none is set", async () => {
    const result = await checkTaskpilotConnection(clientWith(["a", "b"]), null);

    expect(result).toEqual({ ok: true, projectCount: 2, pin: null });
  });

  it("reports a pin that is in the workspace's projects", async () => {
    const result = await checkTaskpilotConnection(
      clientWith(["a", "pin"]),
      "pin",
    );

    expect(result.pin).toEqual({ projectId: "pin", ok: true });
  });

  it("reports a pin that is not in the workspace's projects, without throwing", async () => {
    const result = await checkTaskpilotConnection(
      clientWith(["a", "b"]),
      "pin",
    );

    expect(result).toMatchObject({
      ok: true,
      projectCount: 2,
      pin: { projectId: "pin", ok: false },
    });
  });

  it("makes a single request for the project list", async () => {
    const client = clientWith(["pin"]);

    await checkTaskpilotConnection(client, "pin");

    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });
});
