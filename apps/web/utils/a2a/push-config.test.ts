import { describe, expect, it, vi, beforeEach } from "vitest";
import type { A2aAuthContext } from "@/utils/a2a/auth";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: {
    a2aTask: { findUnique: vi.fn() },
    a2aWebhookConfig: {
      upsert: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  },
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);

const {
  handlePushConfigSet,
  handlePushConfigGet,
  handlePushConfigList,
  handlePushConfigDelete,
} = await import("@/utils/a2a/push-config");

const authContext = {
  userId: "user_1",
  emailAccountId: "acct_1",
  clientId: "client_1",
} as A2aAuthContext;

describe("push notification config", () => {
  // vi.restoreAllMocks() only restores vi.spyOn() spies, not the plain
  // vi.fn() mocks the factory above creates — it would silently leave every
  // mock's call history from the previous test in place. vi.resetAllMocks()
  // is the one that actually clears calls and implementations for these.
  beforeEach(() => vi.resetAllMocks());

  it("refuses a config for a task the caller does not own", async () => {
    // The whole point of §13.1: scope BEFORE the write. A peer must not be
    // able to attach its own webhook URL to another peer's task and receive
    // that task's payloads.
    vi.mocked(prisma.a2aTask.findUnique).mockResolvedValue(null);

    await expect(
      handlePushConfigSet(authContext, {
        taskId: "task_owned_by_someone_else",
        pushNotificationConfig: { url: "https://attacker.example/hook" },
      }),
    ).rejects.toThrow(/not found/i);

    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
  });

  it("never returns the HMAC secret", async () => {
    vi.mocked(prisma.a2aTask.findUnique).mockResolvedValue({
      taskId: "task_1",
    } as any);
    vi.mocked(prisma.a2aWebhookConfig.findFirst).mockResolvedValue({
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

  it("rejects a non-https callback url", async () => {
    vi.mocked(prisma.a2aTask.findUnique).mockResolvedValue({
      taskId: "task_1",
    } as any);

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
    vi.mocked(prisma.a2aWebhookConfig.findFirst).mockResolvedValue(null);
    vi.mocked(prisma.a2aWebhookConfig.create).mockResolvedValue({
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

  it("lists only the caller's own configs for the task", async () => {
    vi.mocked(prisma.a2aTask.findUnique).mockResolvedValue({
      taskId: "task_1",
    } as any);
    vi.mocked(prisma.a2aWebhookConfig.findMany).mockResolvedValue([]);

    await handlePushConfigList(authContext, { taskId: "task_1" });

    expect(
      vi.mocked(prisma.a2aWebhookConfig.findMany).mock.calls[0][0]?.where
        ?.clientId,
    ).toBe("client_1");
  });

  it("deletes only within the caller's scope", async () => {
    vi.mocked(prisma.a2aTask.findUnique).mockResolvedValue({
      taskId: "task_1",
    } as any);
    vi.mocked(prisma.a2aWebhookConfig.deleteMany).mockResolvedValue({
      count: 1,
    });

    const result = await handlePushConfigDelete(authContext, {
      taskId: "task_1",
    });

    expect(result.deleted).toBe(true);
    expect(
      vi.mocked(prisma.a2aWebhookConfig.deleteMany).mock.calls[0][0]?.where
        ?.clientId,
    ).toBe("client_1");
  });
});
