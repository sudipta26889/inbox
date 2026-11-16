import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { encryptToken } from "@/utils/encryption";
import {
  getTaskpilotClientForUser,
  getTaskpilotConfigForUser,
  getTaskpilotConfigStatus,
} from "@/utils/taskpilot/config";
import { TaskpilotNotConfiguredError } from "@/utils/taskpilot/errors";

vi.mock("@/utils/prisma");

const userId = "user-test-1";

describe("getTaskpilotConfigForUser", () => {
  it("throws TaskpilotNotConfiguredError when fields are missing", async () => {
    prisma.user.findUnique.mockResolvedValue({
      taskpilotApiKey: null,
      taskpilotWorkspaceSlug: null,
    } as never);
    await expect(getTaskpilotConfigForUser(userId)).rejects.toBeInstanceOf(
      TaskpilotNotConfiguredError,
    );
  });

  it("returns decrypted config when both fields are set", async () => {
    prisma.user.findUnique.mockResolvedValue({
      taskpilotApiKey: encryptToken("tk_secret"),
      taskpilotWorkspaceSlug: "acme",
    } as never);
    const cfg = await getTaskpilotConfigForUser(userId);
    expect(cfg).toEqual({
      apiKey: "tk_secret",
      workspaceSlug: "acme",
      projectId: null,
    });
  });
});

describe("the project pin", () => {
  const PIN = "683db6a7-472b-4aa6-b7f1-c527f18579ee";

  it("is returned with the config and the status", async () => {
    prisma.user.findUnique.mockResolvedValue({
      taskpilotApiKey: encryptToken("tk_secret"),
      taskpilotWorkspaceSlug: "acme",
      taskpilotProjectId: PIN,
    } as never);

    expect((await getTaskpilotConfigForUser(userId)).projectId).toBe(PIN);
    expect(await getTaskpilotConfigStatus(userId)).toEqual({
      configured: true,
      projectId: PIN,
      workspaceSlug: "acme",
    });
  });

  it("is null in the status when unset", async () => {
    prisma.user.findUnique.mockResolvedValue({
      taskpilotApiKey: null,
      taskpilotWorkspaceSlug: null,
      taskpilotProjectId: null,
    } as never);

    expect(await getTaskpilotConfigStatus(userId)).toEqual({
      configured: false,
      projectId: null,
      workspaceSlug: null,
    });
  });
});

describe("getTaskpilotClientForUser", () => {
  it("returns a client when configured", async () => {
    prisma.user.findUnique.mockResolvedValue({
      taskpilotApiKey: encryptToken("tk_secret"),
      taskpilotWorkspaceSlug: "acme",
    } as never);
    const client = await getTaskpilotClientForUser(userId);
    expect(client).toBeDefined();
  });
});
