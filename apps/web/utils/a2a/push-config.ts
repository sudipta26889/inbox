import "server-only";
import { randomBytes } from "node:crypto";
import type { A2aAuthContext } from "@/utils/a2a/auth";
import { taskScope } from "@/utils/a2a/task-scope";
import { WEBHOOK_EVENTS } from "@/utils/a2a/webhooks";
import prisma from "@/utils/prisma";

/**
 * A2A v1.0 §3.1.7 push notification configuration.
 *
 * The agent card has always advertised `pushNotifications: true` while the
 * spec's four methods returned -32601. The delivery side — HMAC signing,
 * retry, A2aWebhookDelivery records — already existed and is untouched here;
 * this only puts the standard-named RPC surface in front of it.
 *
 * A config with a NULL taskId is the client's default, which is what the
 * pre-§3.1.7 POST /api/user/a2a-webhooks route writes. queueWebhook prefers
 * a task-specific row and falls back to the default.
 */

const DEFAULT_EVENTS: string[] = Object.values(WEBHOOK_EVENTS);

type PushNotificationConfig = {
  url: string;
  token?: string;
  authentication?: { schemes?: string[] };
};

export type PushConfigResponse = {
  pushNotificationConfigId: string;
  taskId: string | null;
  url: string;
  enabled: boolean;
  events: string[];
};

export async function handlePushConfigSet(
  authContext: A2aAuthContext,
  params: { taskId?: string; pushNotificationConfig: PushNotificationConfig },
): Promise<PushConfigResponse> {
  const { taskId, pushNotificationConfig } = params;

  if (!pushNotificationConfig?.url) {
    throw new Error("pushNotificationConfig.url is required");
  }

  // We don't implement any auth scheme (mTLS, OAuth, etc.) on the delivery
  // side — only the token below. Accepting this silently would leave the
  // peer believing a scheme it named is actually enforced.
  if (pushNotificationConfig.authentication) {
    throw new Error(
      "pushNotificationConfig.authentication is not supported; use token instead",
    );
  }

  assertDeliverableUrl(pushNotificationConfig.url);

  // Scoped BEFORE the write, per §13.1: without this a peer could attach its
  // own callback to another peer's task and be handed that task's payloads.
  if (taskId) await assertTaskInScope(authContext, taskId);

  // Prisma's compound-unique input for {clientId, taskId} can't carry `null`
  // (SQL equality never matches NULL, so the generated type rejects it) —
  // the task-specific upsert below only ever runs with a real taskId string.
  const config = taskId
    ? await prisma.a2aWebhookConfig.upsert({
        where: { clientId_taskId: { clientId: authContext.clientId, taskId } },
        create: {
          clientId: authContext.clientId,
          taskId,
          url: pushNotificationConfig.url,
          secret: randomBytes(32).toString("hex"),
          token: pushNotificationConfig.token,
          enabled: true,
          events: DEFAULT_EVENTS,
        },
        // No `enabled: true` here — this is the UPDATE path, and forcing it
        // on every `set` would silently undo a disable the owner made
        // through POST /api/user/a2a-webhooks. (A disabled client default is
        // still enforced client-wide regardless: see queueWebhook.)
        update: {
          url: pushNotificationConfig.url,
          token: pushNotificationConfig.token,
        },
      })
    : await upsertDefaultConfig(
        authContext.clientId,
        pushNotificationConfig.url,
        pushNotificationConfig.token,
      );

  return toResponse(config);
}

export async function handlePushConfigGet(
  authContext: A2aAuthContext,
  params: { taskId: string },
): Promise<PushConfigResponse> {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId is required");

  await assertTaskInScope(authContext, taskId);

  // The task's own row wins; the client default answers for a task that was
  // never configured individually, which is what actually fires today.
  // `IN (taskId, NULL)` would silently drop the NULL row — SQL's IN never
  // matches NULL — so the fallback is an explicit OR instead.
  const config = await prisma.a2aWebhookConfig.findFirst({
    where: {
      clientId: authContext.clientId,
      OR: [{ taskId }, { taskId: null }],
    },
    // Postgres defaults DESC to NULLS FIRST, which would hand back the
    // default row even when a task-specific one exists; pin NULLS LAST so
    // the non-null, task-specific row always wins the tie.
    orderBy: { taskId: { sort: "desc", nulls: "last" } },
  });

  if (!config)
    throw new Error(`No push notification config for task ${taskId}`);

  return toResponse(config);
}

export async function handlePushConfigList(
  authContext: A2aAuthContext,
  params: { taskId: string },
): Promise<{ configs: PushConfigResponse[] }> {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId is required");

  await assertTaskInScope(authContext, taskId);

  // See handlePushConfigGet for why this is OR + explicit null ordering
  // rather than an `in` filter.
  const configs = await prisma.a2aWebhookConfig.findMany({
    where: {
      clientId: authContext.clientId,
      OR: [{ taskId }, { taskId: null }],
    },
    orderBy: { taskId: { sort: "desc", nulls: "last" } },
  });

  return { configs: configs.map(toResponse) };
}

export async function handlePushConfigDelete(
  authContext: A2aAuthContext,
  params: { taskId: string },
): Promise<{ deleted: boolean }> {
  const { taskId } = params;
  if (!taskId) throw new Error("taskId is required");

  await assertTaskInScope(authContext, taskId);

  // Only the task-specific row. Deleting the client default here would
  // silently disable push for every other task the peer has running.
  const result = await prisma.a2aWebhookConfig.deleteMany({
    where: { clientId: authContext.clientId, taskId },
  });

  return { deleted: result.count > 0 };
}

function assertDeliverableUrl(url: string) {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("pushNotificationConfig.url must be a valid URL");
  }

  // We sign each payload, but the signature does not protect the payload in
  // transit — task input and results go over this wire.
  if (parsed.protocol !== "https:") {
    throw new Error("pushNotificationConfig.url must use https");
  }
}

async function assertTaskInScope(authContext: A2aAuthContext, taskId: string) {
  const task = await prisma.a2aTask.findUnique({
    where: { taskId, ...taskScope(authContext) },
    select: { taskId: true },
  });

  // Same message whether the task is absent or out of scope: §13.1 wants the
  // check to run before any query that could leak that a resource exists.
  if (!task) throw new Error(`Task not found: ${taskId}`);
}

// ponytail: find-then-create/update instead of an atomic upsert, since
// Prisma's compound-unique key can't match a NULL taskId. Two concurrent
// callers setting the same client's default at once could both miss the
// existing row and race on create — the partial unique index still stops
// duplicate rows, so the loser gets a P2002 rather than silently corrupting
// state. Add a catch-and-retry-as-update here if that ever actually fires.
async function upsertDefaultConfig(
  clientId: string,
  url: string,
  token?: string,
) {
  const existing = await prisma.a2aWebhookConfig.findFirst({
    where: { clientId, taskId: null },
  });

  if (existing) {
    // No `enabled: true` here — this is the default row that
    // POST /api/user/a2a-webhooks's kill switch (enabled: false) disables;
    // forcing it back on every `set` would let a peer silently undo that.
    return prisma.a2aWebhookConfig.update({
      where: { id: existing.id },
      data: { url, token },
    });
  }

  return prisma.a2aWebhookConfig.create({
    data: {
      clientId,
      taskId: null,
      url,
      secret: randomBytes(32).toString("hex"),
      token,
      enabled: true,
      events: DEFAULT_EVENTS,
    },
  });
}

function toResponse(config: {
  id: string;
  taskId: string | null;
  url: string;
  enabled: boolean;
  events: string[];
}): PushConfigResponse {
  // No `secret`, no `token`. `secret` is the HMAC key we sign with; `token`
  // is the peer's own shared credential that we echo back on each delivery
  // so it can verify the call came from us — returning either here would
  // hand it to anyone who can query the config (e.g. via `list`), not just
  // the peer receiving deliveries.
  return {
    pushNotificationConfigId: config.id,
    taskId: config.taskId,
    url: config.url,
    enabled: config.enabled,
    events: config.events,
  };
}
