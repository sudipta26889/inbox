import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { A2aAuthContext } from "@/utils/a2a/auth";
import { WEBHOOK_EVENTS } from "@/utils/a2a/webhooks";
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

  afterEach(() => {
    vi.unstubAllEnvs();
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

  it("never returns the peer's push notification token, from get or list", async () => {
    // Unlike `secret`, the peer supplied this value — but it's still a
    // shared credential we echo back only on deliveries, not one to hand
    // back to anyone who can query the config.
    const configWithToken = {
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      token: "PEER_SUPPLIED_TOKEN",
      enabled: true,
      events: ["task.completed"],
    } as any;

    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(configWithToken);

    const getResult = await handlePushConfigGet(authContext, {
      taskId: "task_1",
    });

    expect(JSON.stringify(getResult)).not.toContain("PEER_SUPPLIED_TOKEN");
    expect(getResult).not.toHaveProperty("token");

    prisma.a2aWebhookConfig.findMany.mockResolvedValue([configWithToken]);

    const listResult = await handlePushConfigList(authContext, {
      taskId: "task_1",
    });

    expect(JSON.stringify(listResult)).not.toContain("PEER_SUPPLIED_TOKEN");
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
    // The scope check must run BEFORE the config query, not just before the
    // response is returned — otherwise `assertTaskInScope` could be moved
    // after this query with every test here still green.
    expect(prisma.a2aWebhookConfig.findFirst).not.toHaveBeenCalled();
  });

  it("looks up the task's config through the same shared query as queueWebhook (explicit OR, NULLS LAST), not a second hand-rolled copy", async () => {
    // handlePushConfigGet used to duplicate this query inline; a regression
    // back to a hand-rolled copy (e.g. a plain `in` filter, or DESC without
    // NULLS LAST) would silently hand back the client default instead of a
    // task-specific row and still pass every other test in this file.
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

    const call = prisma.a2aWebhookConfig.findFirst.mock.calls[0][0];
    expect(call?.where).toMatchObject({
      clientId: "client_1",
      OR: [{ taskId: "task_1" }, { taskId: null }],
    });
    expect(call?.orderBy).toEqual({ taskId: { sort: "desc", nulls: "last" } });
  });

  it("reports enabled: false for a task-specific config when the client default is disabled", async () => {
    // getConfigForTask's own OR+NULLS-LAST query resolves the task-specific
    // row (it wins the tie); queueWebhook additionally suppresses delivery
    // because the client default is disabled. A peer told `enabled: true`
    // here would have no way to learn push is actually off.
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockImplementation(({ where }: any) => {
      // isConfigEffectivelyEnabled's own lookup for the client default is a
      // direct `taskId: null` filter with no OR; getConfigForTask's is the
      // OR-based fallback query. Keying on that shape (not call order) is
      // what lets this test tell a correct implementation from a broken one.
      if (where?.taskId === null && !where?.OR) {
        return Promise.resolve({
          id: "cfg_default",
          clientId: "client_1",
          taskId: null,
          url: "https://old.example/hook",
          secret: "s",
          enabled: false,
          events: ["task.completed"],
        }) as any;
      }
      return Promise.resolve({
        id: "cfg_task",
        clientId: "client_1",
        taskId: "task_1",
        url: "https://peer.example/hook",
        secret: "s",
        enabled: true,
        events: ["task.completed"],
      }) as any;
    });

    const result = await handlePushConfigGet(authContext, {
      taskId: "task_1",
    });

    expect(result.enabled).toBe(false);
  });

  it("rejects get when pushNotificationConfigId does not match the config found for the task", async () => {
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

    await expect(
      handlePushConfigGet(authContext, {
        taskId: "task_1",
        pushNotificationConfigId: "cfg_some_other_config",
      }),
    ).rejects.toThrow(/does not match/i);
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

  it("rejects a callback url pointing at a private IP (SSRF)", async () => {
    // Any authenticated peer reaches `set`, not just the account owner — this
    // is the trust-boundary change that makes SSRF validation load-bearing
    // here. Stubbed explicitly so this doesn't depend on the local .env.
    vi.stubEnv("WEBHOOK_ALLOW_PRIVATE_IPS", "false");
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);

    await expect(
      handlePushConfigSet(authContext, {
        taskId: "task_1",
        pushNotificationConfig: { url: "https://192.168.10.252/hook" },
      }),
    ).rejects.toThrow(/not an allowed webhook destination/i);

    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
  });

  it("rejects an auth scheme it does not support, rather than silently ignoring it", async () => {
    // We don't implement any delivery-side auth scheme, only the token. A
    // 200 here would leave the peer believing a scheme it named is enforced.
    await expect(
      handlePushConfigSet(authContext, {
        pushNotificationConfig: {
          url: "https://peer.example/hook",
          authentication: { schemes: ["Bearer"] },
        },
      }),
    ).rejects.toThrow(/authentication/i);

    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.create).not.toHaveBeenCalled();
  });

  it("accepts authentication: { schemes: [] }, since an empty list means the same as omitting it", async () => {
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
      pushNotificationConfig: {
        url: "https://peer.example/hook",
        authentication: { schemes: [] },
      },
    });

    expect(result.taskId).toBeNull();
    expect(prisma.a2aWebhookConfig.create).toHaveBeenCalled();
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
      token: "default-token",
      enabled: true,
      events: ["task.completed"],
    } as any);

    const result = await handlePushConfigSet(authContext, {
      pushNotificationConfig: {
        url: "https://peer.example/hook",
        token: "default-token",
      },
    });

    expect(result.taskId).toBeNull();
    expect(prisma.a2aTask.findUnique).not.toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.a2aWebhookConfig.create.mock.calls[0][0].data.token).toBe(
      "default-token",
    );
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
      pushNotificationConfig: {
        url: "https://peer.example/hook",
        token: "peer-token",
      },
    });

    const call = prisma.a2aWebhookConfig.upsert.mock.calls[0][0];
    expect(call.update).not.toHaveProperty("enabled");
    // token is stored on both branches of the upsert — whichever one the DB
    // actually takes should end up with it.
    expect(call.create.token).toBe("peer-token");
    expect(call.update.token).toBe("peer-token");
  });

  it("clears a task-specific config's stored token when a peer re-sets without one", async () => {
    // Prisma treats `undefined` as "no change" on update — passing the bare
    // (possibly-absent) token through would leave the OLD token in place,
    // and deliverWebhook would keep echoing it to the NEW url. A2A §3.1.7
    // `set` is a replace, not a merge.
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.upsert.mockResolvedValue({
      id: "cfg_1",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed"],
    } as any);

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: {
        url: "https://peer.example/hook",
        token: "first-token",
      },
    });

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    const secondCall = prisma.a2aWebhookConfig.upsert.mock.calls[1][0];
    expect(secondCall.update.token).toBeNull();
    expect(secondCall.update.token).not.toBeUndefined();
  });

  it("clears the client-default config's stored token when a peer re-sets without one", async () => {
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://old.example/hook",
      secret: "s",
      token: "old-token",
      enabled: true,
      events: ["task.completed"],
    } as any);
    prisma.a2aWebhookConfig.update.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed"],
    } as any);

    await handlePushConfigSet(authContext, {
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    const call = prisma.a2aWebhookConfig.update.mock.calls[0][0];
    expect(call.data.token).toBeNull();
    expect(call.data.token).not.toBeUndefined();
  });

  it("a new task-specific row inherits the client default's events instead of every event", async () => {
    // isConfigEffectivelyEnabled already folds a disabled client default over
    // a task-specific row's `enabled`; `events` needs the same inheritance —
    // otherwise an owner who deselected an event on their default sees it
    // silently re-enabled the moment a peer calls `set` for a task, since a
    // fresh row used to always subscribe to every event.
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_default",
      clientId: "client_1",
      taskId: null,
      url: "https://old.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed", "task.failed"],
    } as any);
    prisma.a2aWebhookConfig.upsert.mockResolvedValue({
      id: "cfg_task",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: ["task.completed", "task.failed"],
    } as any);

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    const call = prisma.a2aWebhookConfig.upsert.mock.calls[0][0];
    expect(call.create.events).toEqual(["task.completed", "task.failed"]);
  });

  it("falls back to every event for a new task-specific row when the client has no default yet", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue(null);
    prisma.a2aWebhookConfig.upsert.mockResolvedValue({
      id: "cfg_task",
      clientId: "client_1",
      taskId: "task_1",
      url: "https://peer.example/hook",
      secret: "s",
      enabled: true,
      events: Object.values(WEBHOOK_EVENTS),
    } as any);

    await handlePushConfigSet(authContext, {
      taskId: "task_1",
      pushNotificationConfig: { url: "https://peer.example/hook" },
    });

    const call = prisma.a2aWebhookConfig.upsert.mock.calls[0][0];
    expect(call.create.events).toEqual(Object.values(WEBHOOK_EVENTS));
  });

  it("does not re-enable a client-default config the owner disabled through POST /api/user/a2a-webhooks", async () => {
    // That route is the only thing that can disable this row. A peer calling
    // `set` with no taskId must not be able to flip it back on as a side
    // effect of updating the url.
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
      pushNotificationConfig: {
        url: "https://peer.example/hook",
        token: "rotated-token",
      },
    });

    expect(result.enabled).toBe(false);
    expect(prisma.a2aWebhookConfig.update.mock.calls[0][0].data.token).toBe(
      "rotated-token",
    );
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

  it("rejects delete when pushNotificationConfigId does not match the config found for the task, and deletes nothing", async () => {
    prisma.a2aTask.findUnique.mockResolvedValue({ taskId: "task_1" } as any);
    prisma.a2aWebhookConfig.findFirst.mockResolvedValue({
      id: "cfg_actual",
    } as any);

    await expect(
      handlePushConfigDelete(authContext, {
        taskId: "task_1",
        pushNotificationConfigId: "cfg_some_other_config",
      }),
    ).rejects.toThrow(/does not match/i);

    expect(prisma.a2aWebhookConfig.deleteMany).not.toHaveBeenCalled();
  });
});
