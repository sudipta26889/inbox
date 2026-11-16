import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { A2aAuthContext } from "@/utils/a2a/auth";
import { A2aTaskState, A2aWebhookStatus } from "@/generated/prisma/enums";
import { handlePushConfigSet } from "@/utils/a2a/push-config";
import {
  WEBHOOK_EVENTS,
  deliverWebhook,
  queueWebhook,
  cleanupOrphanedTaskWebhookConfigs,
} from "@/utils/a2a/webhooks";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

const authContext = {
  userId: "user_1",
  emailAccountId: "acct_1",
  clientId: "client_1",
} as A2aAuthContext;

// Selected fields queueWebhook reads off the task row (see the `select` in
// queueWebhook) plus the two ids it looks the row up by.
const fakeTask = {
  id: "internal_task_1",
  taskId: "task_1",
  clientId: "client_1",
  userId: "user_1",
  contextId: "ctx_1",
  skill: "some.skill",
  input: {},
  state: A2aTaskState.working,
  stateReason: null,
  result: null,
  error: null,
  requiresApproval: false,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  completedAt: null,
} as any;

function fakeConfig(overrides: Record<string, unknown>) {
  return {
    id: "cfg",
    clientId: "client_1",
    taskId: "task_1",
    url: "https://peer.example/hook",
    secret: "s",
    token: null,
    enabled: true,
    events: [WEBHOOK_EVENTS.TASK_STATE_CHANGED],
    ...overrides,
  } as any;
}

describe("queueWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("looks up the config with an explicit OR and NULLS LAST, not IN or a plain DESC", async () => {
    // Two forms that have shipped broken before, both silently routing every
    // task's payload to the client-default URL (signed with a different
    // secret than the peer's per-task row):
    //   - `taskId: { in: [taskId, null] }` — SQL IN never matches NULL, so
    //     the default row vanishes from the result set entirely except when
    //     it's the ONLY row, making this look right in the common case.
    //   - `orderBy: { taskId: "desc" }` — Postgres defaults DESC to NULLS
    //     FIRST, so the default would win the tie over a task-specific row.
    prisma.a2aTask.findUnique.mockResolvedValue(fakeTask);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(fakeConfig({}));
    prisma.a2aWebhookDelivery.create.mockResolvedValue({} as any);

    await queueWebhook("internal_task_1", WEBHOOK_EVENTS.TASK_STATE_CHANGED);

    const call = prisma.a2aWebhookConfig.findFirst.mock.calls[0][0];
    expect(call?.where).toMatchObject({
      clientId: "client_1",
      OR: [{ taskId: "task_1" }, { taskId: null }],
    });
    expect(call?.orderBy).toEqual({ taskId: { sort: "desc", nulls: "last" } });
  });

  it("still delivers when the client has no default row, only a task-specific config", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue(fakeTask);
    prisma.a2aWebhookConfig.findFirst
      .mockResolvedValueOnce(fakeConfig({ enabled: true }))
      .mockResolvedValueOnce(null); // no client-default row exists at all
    prisma.a2aWebhookDelivery.create.mockResolvedValue({} as any);

    await queueWebhook("internal_task_1", WEBHOOK_EVENTS.TASK_STATE_CHANGED);

    expect(prisma.a2aWebhookDelivery.create).toHaveBeenCalled();
  });

  it("still delivers when the client default is enabled", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue(fakeTask);
    prisma.a2aWebhookConfig.findFirst
      .mockResolvedValueOnce(fakeConfig({ enabled: true }))
      .mockResolvedValueOnce(
        fakeConfig({ taskId: null, enabled: true, id: "cfg_default" }),
      );
    prisma.a2aWebhookDelivery.create.mockResolvedValue({} as any);

    await queueWebhook("internal_task_1", WEBHOOK_EVENTS.TASK_STATE_CHANGED);

    expect(prisma.a2aWebhookDelivery.create).toHaveBeenCalled();
  });

  it("does not queue delivery for an enabled task-specific config when the client default is disabled", async () => {
    // Reproduces the reported bypass: the owner disables the client default
    // through POST /api/user/a2a-webhooks; a peer then calls
    // pushNotificationConfig.set WITH a taskId, creating a fresh
    // task-specific row. Confirm that row is still created enabled (the
    // CREATE path is untouched — only queueWebhook enforces the switch)...
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.upsert.mockResolvedValue(
      fakeConfig({ id: "cfg_task" }),
    );

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    expect(prisma.a2aWebhookConfig.upsert.mock.calls[0][0].create.enabled).toBe(
      true,
    );

    // ...then confirm delivery is still suppressed: the disabled default
    // must act as a client-wide kill switch even though the task's own row
    // says enabled: true and would otherwise win the lookup above.
    vi.clearAllMocks();
    prisma.a2aTask.findUnique.mockResolvedValue(fakeTask);
    prisma.a2aWebhookConfig.findFirst
      .mockResolvedValueOnce(fakeConfig({ id: "cfg_task", enabled: true }))
      .mockResolvedValueOnce(
        fakeConfig({
          id: "cfg_default",
          taskId: null,
          url: "https://old.example/hook",
          enabled: false,
        }),
      );

    await queueWebhook("internal_task_1", WEBHOOK_EVENTS.TASK_STATE_CHANGED);

    expect(prisma.a2aWebhookDelivery.create).not.toHaveBeenCalled();
  });
});

describe("deliverWebhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends the peer's stored token back as X-A2A-Notification-Token", async () => {
    prisma.a2aWebhookDelivery.findUnique.mockResolvedValue({
      id: "delivery_1",
      taskId: "internal_task_1",
      clientId: "client_1",
      url: "https://peer.example/hook",
      method: "POST",
      event: WEBHOOK_EVENTS.TASK_COMPLETED,
      payload: {},
      signature: "sha256=abc",
      status: A2aWebhookStatus.pending,
      attempts: 0,
      maxAttempts: 5,
    } as any);
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(
      fakeConfig({ token: "peer-issued-token" }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    });
    prisma.a2aWebhookDelivery.update.mockResolvedValue({} as any);

    await deliverWebhook("delivery_1");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers["X-A2A-Notification-Token"]).toBe(
      "peer-issued-token",
    );
  });

  it("omits the token header when none is configured", async () => {
    prisma.a2aWebhookDelivery.findUnique.mockResolvedValue({
      id: "delivery_1",
      taskId: "internal_task_1",
      clientId: "client_1",
      url: "https://peer.example/hook",
      method: "POST",
      event: WEBHOOK_EVENTS.TASK_COMPLETED,
      payload: {},
      signature: "sha256=abc",
      status: A2aWebhookStatus.pending,
      attempts: 0,
      maxAttempts: 5,
    } as any);
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(
      fakeConfig({ token: null }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(""),
    });
    prisma.a2aWebhookDelivery.update.mockResolvedValue({} as any);

    await deliverWebhook("delivery_1");

    const [, options] = mockFetch.mock.calls[0];
    expect(options.headers).not.toHaveProperty("X-A2A-Notification-Token");
  });

  it("does not fire, and records the delivery as failed, when the config was disabled after it was queued", async () => {
    // Retries happen up to 5 times over minutes; the owner may disable push
    // in between. Without this guard, a delivery queued while push was on
    // keeps firing through every retry regardless of what the peer does.
    prisma.a2aWebhookDelivery.findUnique.mockResolvedValue({
      id: "delivery_1",
      taskId: "internal_task_1",
      clientId: "client_1",
      url: "https://peer.example/hook",
      method: "POST",
      event: WEBHOOK_EVENTS.TASK_COMPLETED,
      payload: {},
      signature: "sha256=abc",
      status: A2aWebhookStatus.pending,
      attempts: 0,
      maxAttempts: 5,
    } as any);
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(
      fakeConfig({ enabled: false }),
    );
    prisma.a2aWebhookDelivery.update.mockResolvedValue({} as any);

    const result = await deliverWebhook("delivery_1");

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(prisma.a2aWebhookDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "delivery_1" },
        data: expect.objectContaining({ status: A2aWebhookStatus.failed }),
      }),
    );
  });

  it("does not fire, and records the delivery as failed, when the config row was deleted after it was queued", async () => {
    prisma.a2aWebhookDelivery.findUnique.mockResolvedValue({
      id: "delivery_1",
      taskId: "internal_task_1",
      clientId: "client_1",
      url: "https://peer.example/hook",
      method: "POST",
      event: WEBHOOK_EVENTS.TASK_COMPLETED,
      payload: {},
      signature: "sha256=abc",
      status: A2aWebhookStatus.pending,
      attempts: 0,
      maxAttempts: 5,
    } as any);
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    // e.g. the owner called DELETE /api/user/a2a-webhooks, which now removes
    // every row for the client (see route.ts) rather than just the default.
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(null);
    prisma.a2aWebhookDelivery.update.mockResolvedValue({} as any);

    const result = await deliverWebhook("delivery_1");

    expect(result).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("cleanupOrphanedTaskWebhookConfigs", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes a task-specific row whose task reached a terminal state", async () => {
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([
      { taskId: "task_done" },
    ] as any);
    prisma.a2aTask.findMany.mockResolvedValue([
      { taskId: "task_done", state: A2aTaskState.completed },
    ] as any);
    prisma.a2aWebhookConfig.deleteMany.mockResolvedValue({ count: 1 });

    const deleted = await cleanupOrphanedTaskWebhookConfigs();

    expect(deleted).toBe(1);
    expect(prisma.a2aWebhookConfig.deleteMany).toHaveBeenCalledWith({
      where: { taskId: { in: ["task_done"] } },
    });
  });

  it("deletes a task-specific row whose task no longer exists at all", async () => {
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([
      { taskId: "task_gone" },
    ] as any);
    prisma.a2aTask.findMany.mockResolvedValue([]); // the a2aTask row is gone
    prisma.a2aWebhookConfig.deleteMany.mockResolvedValue({ count: 1 });

    const deleted = await cleanupOrphanedTaskWebhookConfigs();

    expect(deleted).toBe(1);
    expect(prisma.a2aWebhookConfig.deleteMany).toHaveBeenCalledWith({
      where: { taskId: { in: ["task_gone"] } },
    });
  });

  it("keeps a task-specific row whose task is still active", async () => {
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([
      { taskId: "task_active" },
    ] as any);
    prisma.a2aTask.findMany.mockResolvedValue([
      { taskId: "task_active", state: A2aTaskState.working },
    ] as any);

    const deleted = await cleanupOrphanedTaskWebhookConfigs();

    expect(deleted).toBe(0);
    expect(prisma.a2aWebhookConfig.deleteMany).not.toHaveBeenCalled();
  });

  /**
   * The client-default row (taskId: null) is owner-configured and has no
   * task lifecycle — it must never be deleted by this cleanup, even when
   * other task-specific rows for the same client are. The exclusion is
   * structural: the very first query only ever selects taskId IS NOT NULL
   * rows, so a default row can never enter the candidate set in the first
   * place, regardless of what state any task is in.
   */
  it("never queries or deletes the client-default row (taskId: null)", async () => {
    prisma.a2aWebhookConfig.findMany.mockResolvedValue([]);

    const deleted = await cleanupOrphanedTaskWebhookConfigs();

    expect(deleted).toBe(0);
    expect(prisma.a2aWebhookConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { taskId: { not: null } } }),
    );
    expect(prisma.a2aWebhookConfig.deleteMany).not.toHaveBeenCalled();
  });
});
