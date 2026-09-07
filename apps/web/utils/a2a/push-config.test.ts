import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { A2aAuthContext } from "@/utils/a2a/auth";
import {
  handlePushConfigDelete,
  handlePushConfigGet,
  handlePushConfigList,
  handlePushConfigSet,
} from "@/utils/a2a/push-config";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const authContext = {
  userId: "user_1",
  emailAccountId: "acct_1",
  clientId: "client_1",
} as A2aAuthContext;

describe("push notification config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("refuses a config for a task the caller does not own", async () => {
    // The whole point of §13.1: scope BEFORE the write. A peer must not be
    // able to attach its own webhook URL to another peer's task and receive
    // that task's payloads.
    prisma.a2aTask.findUnique.mockResolvedValue(null);

    await expect(
      handlePushConfigSet(authContext, {
        taskId: "task_owned_by_someone_else",
        pushNotificationConfig: { url: "https://attacker.example/hook" },
      }),
    ).rejects.toThrow(/not found/i);

    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
  });

  it("scopes the task lookup by user, account and peer client id", async () => {
    // Guards the shape of assertTaskInScope's own query: a mutation that
    // narrows `where` back down to `{ taskId }` alone reintroduces the
    // cross-peer leak §13.1 exists to prevent.
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed"],
    } as any);

    await handlePushConfigGet(authContext, { taskId: "task_1" });

    expect(prisma.a2aTask.findUnique).toHaveBeenCalledWith({
      where: {
        taskId: "task_1",
        userId: "user_1",
        emailAccountId: "acct_1",
        clientId: "client_1",
      },
      select: { taskId: true },
    });
  });

  it("never returns the HMAC secret", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "SUPER_SECRET_HMAC_KEY",
      enabled: true,
      events: ["task.completed"],
    } as any);

    const result = await handlePushConfigGet(authContext, {
      taskId: "task_1",
    });

    expect(JSON.stringify(result)).not.toContain("SUPER_SECRET_HMAC_KEY");
    expect(result).not.toHaveProperty("secret");
  });

  it("rejects get for a task outside the caller's scope, even if a config exists for it", async () => {
    // Without the scope check, `get` would still find and return a config
    // for a taskId the caller doesn't own — the check must run first, not
    // rely on the config query itself coming up empty.
    prisma.a2aTask.findUnique.mockResolvedValue(null);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed"],
    } as any);

    await expect(
      handlePushConfigGet(authContext, { taskId: "task_1" }),
    ).rejects.toThrow("Task not found: task_1");

    expect(prisma.a2aTask.findUnique).toHaveBeenCalled();
  });

  it("rejects a non-https callback url", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);

    await expect(
      handlePushConfigSet(authContext, {
        taskId: "task_1",
        pushNotificationConfig: { url: "http://peer.example/hook" },
      }),
    ).rejects.toThrow(/https/i);
  });

  it("stores a client-level default when no taskId is given", async () => {
    // No compound-unique upsert here: Prisma's {clientId, taskId} unique
    // input can't carry null, so the default path finds then creates/updates.
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(null);
    prisma.a2aWebhookConfig.create.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed"],
    } as any);

    const result = await handlePushConfigSet(authContext, {
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    expect(result.taskId).toBeNull();
    expect(prisma.a2aTask.findUnique).not.toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
  });

  it("does not re-enable an existing task-specific config a set silently disabled elsewhere", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.upsert.mockResolvedValue({
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: false,
      events: ["task.completed"],
    } as any);

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    const call = prisma.a2aWebhookConfig.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("enabled");
  });

  it("does not re-enable a client-default config the owner disabled through the settings UI", async () => {
    // The settings UI at /api/user/a2a-webhooks is the only thing that can
    // disable this row. A peer calling `set` with no taskId must not be able
    // to flip it back on as a side effect of updating the url.
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://old.example/hook",
      secret: "s",
      enabled: false,
      events: ["task.completed"],
    } as any);
    prisma.a2aWebhookConfig.update.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://peer.example/hook",
      secret: "s",
      enabled: false,
      events: ["task.completed"],
    } as any);

    const result = await handlePushConfigSet(authContext, {
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    expect(result.enabled).toBe(false);
    const call = prisma.a2aWebhookConfig.update.mock.calls[0][0];
    expect(call.data).not.toHaveProperty("enabled");
  });

  it("lists only the caller's own configs for the task", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([]);

    await handlePushConfigList(authContext, { taskId: "task_1" });

    expect(
      prisma.a2aWebhookConfig.findMany.mock.calls[0][0]?.where?.clientId,
    ).toBe("client_1");
  });

  it("rejects list for a task outside the caller's scope, even if configs exist for it", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue(null);
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([
      {
        id: "cfg_1",
        clientId: "client_1",
        taskId: "task_1",
        url: "https://peer.example/hook",
        secret: "s",
        enabled: true,
        events: ["task.completed"],
      } as any,
    ]);

    await expect(
      handlePushConfigList(authContext, { taskId: "task_1" }),
    ).rejects.toThrow("Task not found: task_1");

    expect(prisma.a2aTask.findUnique).toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.findMany).not.toHaveBeenCalled();
  });

  it("deletes only within the caller's scope", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.deleteMany.mockResolvedValue({ count: 1 });

    const result = await handlePushConfigDelete(authContext, {
      taskId: "task_1",
    });

    expect(result.deleted).toBe(true);
    expect(
      prisma.a2aWebhookConfig.deleteMany.mock.calls[0][0]?.where?.clientId,
    ).toBe("client_1");
  });

  it("rejects delete for a task outside the caller's scope, even if a row exists for it", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue(null);
    prisma.a2aWebhookConfig.deleteMany.mockResolvedValue({ count: 1 });

    await expect(
      handlePushConfigDelete(authContext, { taskId: "task_1" }),
    ).rejects.toThrow("Task not found: task_1");

    expect(prisma.a2aTask.findUnique).toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.deleteMany).not.toHaveBeenCalled();
  });
});
