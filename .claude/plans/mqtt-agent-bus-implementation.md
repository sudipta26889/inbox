# MQTT Agent Bus Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish Inbox state to the MQTT broker directly, as retained
Home-Assistant-discoverable entities, so agents and dashboards on the LAN learn
about the inbox without polling and without routing through Home Assistant's
REST API.

**Architecture:** One long-lived MQTT client owned by a lazy singleton in the web
container, publishing fire-and-forget. Topic and payload construction is a
separate pure module so the privacy rules are unit-testable without a broker.
Four event publishers check per-account opt-in before building anything. The
three existing HA-proxied rules keep their exact topics and payloads and only
change transport.

**Tech Stack:** `mqtt@5.15.2`, Next.js 15 App Router, Prisma 7 (client generated
to `@/generated/prisma`), Vitest, Biome/ultracite.

**Spec:** `.claude/.docs/mqtt-agent-bus.md`

## Global Constraints

- Publishing **must fail soft**. `publishMqtt()` never throws, never awaits a
  broker ack in a caller's path, never fails a rule or blocks a send. A broker
  outage must leave mail processing untouched.
- **Nothing publishes** for an account unless `mqttEnabled` is true.
- **No email address anywhere** — not in payloads, not in topics. That is what
  `mqttTopicSlug` is for.
- Default payloads carry **counts and classifications only**. `subject` and
  `from` appear only when that account has `mqttIncludeDetail`.
- MQTT client id must be **unique per process**: `inbox-<pid>-<random>`. Two
  connections sharing a client id make the broker disconnect the first, which
  presents as an endless reconnect loop.
- All `state`, `attributes`, `availability` and discovery `config` topics are
  published **retained**.
- The three existing rule topics
  (`homeassistant/inbox/{urgent,imp-notify,remittance}`) keep **byte-identical
  payloads**. Only the transport changes.
- Tests use the real logger (never mock `@/utils/logger`) and must
  `vi.mock("server-only", () => ({}))` for server-only modules.
- In `vi.hoisted` blocks use `vi.fn().mockReturnValue(x)`, never `vi.fn(() => x)`.
  The latter infers a zero-arity call tuple, so `mock.calls[0][1]` fails the
  type ratchet — which type-checks test files, unlike `tsconfig.build.json`.
  This matches the existing pattern in `utils/longmemory/client.test.ts`.
- Run `pnpm install` in `apps/web` before the first build.
- Do not run `pnpm dev` or `pnpm build` unless explicitly asked.
- Type ratchet is at `{total: 0, source: 0}`. Any new type error fails the
  pre-commit hook.

---

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/utils/mqtt/client.ts` | Owns the connection. Lazy singleton, reconnect, LWT, bounded queue, fail-soft `publishMqtt()`. |
| `apps/web/utils/mqtt/topics.ts` | Pure topic + payload construction, slug validation, discovery configs. No I/O. Privacy rules live here. |
| `apps/web/utils/mqtt/events.ts` | The four publishers. Checks opt-in, calls topics + client. |
| `apps/web/utils/home-assistant.ts` | Modified: `executeMqttPublish` swaps HA REST for direct publish. |
| `apps/web/prisma/schema.prisma` | Modified: three columns on `EmailAccount`. |
| `apps/web/env.ts` | Modified: four MQTT vars. |

Tests sit next to their source (`client.test.ts`, `topics.test.ts`,
`events.test.ts`) per `AGENTS.md`.

---

### Task 1: Configuration and dependency

Nothing publishes yet. This task exists so every later task can read config.

**Files:**
- Modify: `/mnt/projects/inbox/apps/web/.env`
- Modify: `/mnt/projects/inbox/apps/web/.env.example`
- Modify: `/mnt/projects/inbox/apps/web/env.ts:287`
- Modify: `/mnt/projects/inbox/turbo.json`
- Modify: `/mnt/projects/inbox/apps/web/package.json`

**Interfaces:**
- Produces: `env.MQTT_HOST`, `env.MQTT_PORT`, `env.MQTT_USERNAME`,
  `env.MQTT_PASSWORD` — all `optional()`, so deployments without a broker are
  unaffected.

- [ ] **Step 1: Copy the four vars from the repo root into the app env**

The container reads `env_file: ./apps/web/.env`, so vars in the root `.env`
alone are invisible to the app.

```bash
cd /mnt/projects/inbox
grep -E '^MQTT_' .env >> apps/web/.env
grep -cE '^MQTT_' apps/web/.env   # expect 4
```

- [ ] **Step 2: Document them in `.env.example`**

Append to `apps/web/.env.example`, in the fork-additions section:

```bash
# MQTT agent bus. Publishes inbox state as retained, Home-Assistant-discoverable
# entities. Unset means no broker and nothing is published.
# MQTT_HOST=homeassistant.lan
# MQTT_PORT=1883
# MQTT_USERNAME=
# MQTT_PASSWORD=
```

- [ ] **Step 3: Declare them in `env.ts`**

In the `server` block, immediately after `LONGMEMORY_API_KEY` (line 287):

```ts
    // MQTT agent bus. All optional: no broker configured means no publishing.
    MQTT_HOST: z.string().optional(),
    MQTT_PORT: z.coerce.number().optional(),
    MQTT_USERNAME: z.string().optional(),
    MQTT_PASSWORD: z.string().optional(),
```

- [ ] **Step 4: Add them to `turbo.json`**

Both `env` arrays that already list `LONGMEMORY_API_KEY` get:

```json
        "MQTT_HOST",
        "MQTT_PORT",
        "MQTT_USERNAME",
        "MQTT_PASSWORD"
```

Do **not** reformat the file — edit in place, preserving the blank-line
grouping. Verify with `python3 -c 'import json; json.load(open("turbo.json"))'`.

- [ ] **Step 5: Install the client library**

```bash
cd /mnt/projects/inbox/apps/web && pnpm add mqtt@5.15.2
```

- [ ] **Step 6: Verify env parity**

```bash
cd /mnt/projects/inbox/apps/web
diff <(grep -oE '^[A-Z_][A-Z0-9_]*=' .env | sort -u) \
     <(grep -oE '^#? ?[A-Z_][A-Z0-9_]*=' .env.example | sed 's/^# *//' | sort -u) \
  | grep '^<' || echo "PARITY OK"
```
Expected: `PARITY OK`

- [ ] **Step 7: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/.env.example apps/web/env.ts turbo.json apps/web/package.json pnpm-lock.yaml
git commit -m "chore(mqtt): add broker config and the mqtt client library"
```

---

### Task 2: Topic and payload construction

Pure module, no I/O. Written first because every later task depends on its
names, and because the privacy rules belong somewhere testable without a broker.

**Files:**
- Create: `apps/web/utils/mqtt/topics.ts`
- Test: `apps/web/utils/mqtt/topics.test.ts`

**Interfaces:**
- Produces:
  - `AVAILABILITY_TOPIC: "inbox/availability"`
  - `isValidSlug(slug: string): boolean`
  - `entityTopics(slug: string, entity: MqttEntity): { state: string; attributes: string; config: string }`
  - `discoveryConfig(args: { slug: string; entity: MqttEntity; name: string; icon: string }): Record<string, unknown>`
  - `type MqttEntity = "unread" | "urgent" | "digest" | "approvals"`
  - `unreadPayload({ unread, total }): { state: string; attributes: Record<string, unknown> }`
  - `urgentPayload({ ruleName, countToday, at, detail? }): { state: string; attributes: Record<string, unknown> }`
  - `digestPayload({ items, at }): { state: string; attributes: Record<string, unknown> }`
  - `approvalsPayload({ pending, oldestWaitingSeconds, actions }): { state: string; attributes: Record<string, unknown> }`

- [ ] **Step 1: Write the failing test**

Create `apps/web/utils/mqtt/topics.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  AVAILABILITY_TOPIC,
  discoveryConfig,
  entityTopics,
  isValidSlug,
  unreadPayload,
  urgentPayload,
} from "./topics";

describe("topics", () => {
  it("puts an account's entities under its own slug", () => {
    expect(entityTopics("work", "unread")).toEqual({
      state: "inbox/work/unread/state",
      attributes: "inbox/work/unread/attributes",
      config: "homeassistant/sensor/inbox_work/unread/config",
    });
  });

  it("names one availability topic for the whole service", () => {
    expect(AVAILABILITY_TOPIC).toBe("inbox/availability");
  });

  /**
   * A slug lands in a topic string and an HA unique_id, so anything that would
   * break either — a slash, a wildcard, a space — has to be refused.
   */
  it("refuses a slug that would corrupt a topic or an HA id", () => {
    expect(isValidSlug("work")).toBe(true);
    expect(isValidSlug("work-2")).toBe(true);
    expect(isValidSlug("a/b")).toBe(false);
    expect(isValidSlug("a#b")).toBe(false);
    expect(isValidSlug("a b")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("A")).toBe(false);
    expect(isValidSlug("x".repeat(40))).toBe(false);
  });

  it("builds a discovery config HA can consume", () => {
    expect(
      discoveryConfig({
        slug: "work",
        entity: "unread",
        name: "Unread",
        icon: "mdi:email",
      }),
    ).toEqual({
      name: "Unread",
      unique_id: "inbox_work_unread",
      state_topic: "inbox/work/unread/state",
      json_attributes_topic: "inbox/work/unread/attributes",
      availability_topic: "inbox/availability",
      device: {
        identifiers: ["inbox_work"],
        name: "Inbox – work",
        manufacturer: "Dhara AI",
        model: "email-agent",
      },
      icon: "mdi:email",
    });
  });

  it("carries counts in the unread payload", () => {
    expect(unreadPayload({ unread: 512, total: 865 })).toEqual({
      state: "512",
      attributes: { total: 865 },
    });
  });

  /**
   * The privacy rule, asserted rather than trusted. This instance is not
   * single-tenant — most accounts belong to other people — and anything with
   * the one MQTT password can read every topic on the broker.
   */
  it("keeps sender and subject out of an urgent payload by default", () => {
    const { attributes } = urgentPayload({
      ruleName: "Urgent",
      countToday: 3,
      at: "2026-09-07T05:00:00.000Z",
    });

    expect(attributes).not.toHaveProperty("subject");
    expect(attributes).not.toHaveProperty("from");
    expect(JSON.stringify(attributes)).not.toMatch(/@/);
  });

  it("includes them only when the account asked for detail", () => {
    const { attributes } = urgentPayload({
      ruleName: "Urgent",
      countToday: 3,
      at: "2026-09-07T05:00:00.000Z",
      detail: { subject: "Invoice", from: "a@b.com" },
    });

    expect(attributes).toMatchObject({ subject: "Invoice", from: "a@b.com" });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `cd /mnt/projects/inbox/apps/web && npx vitest run utils/mqtt/topics.test.ts`
Expected: FAIL — `Cannot find module './topics'`

- [ ] **Step 3: Implement**

Create `apps/web/utils/mqtt/topics.ts`:

```ts
import "server-only";

/**
 * Topic and payload construction for the MQTT agent bus.
 *
 * Pure on purpose: the privacy rules are the load-bearing part of this feature
 * and they should be testable without a broker. Nothing here does I/O.
 *
 * The shape follows the convention already on this broker — availability plus
 * per-entity state/attributes, with retained Home Assistant discovery configs.
 * Matching it means Inbox appears as real HA entities rather than as ad-hoc
 * topics nothing knows how to read.
 */

export const AVAILABILITY_TOPIC = "inbox/availability";
const DISCOVERY_PREFIX = "homeassistant/sensor";

export type MqttEntity = "unread" | "urgent" | "digest" | "approvals";

/**
 * A slug is substituted into a topic string and an HA `unique_id`, so a slash
 * or a wildcard would silently reroute or corrupt another account's topics.
 */
const SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_PATTERN.test(slug);
}

export function entityTopics(slug: string, entity: MqttEntity) {
  return {
    state: `inbox/${slug}/${entity}/state`,
    attributes: `inbox/${slug}/${entity}/attributes`,
    config: `${DISCOVERY_PREFIX}/inbox_${slug}/${entity}/config`,
  };
}

export function discoveryConfig({
  slug,
  entity,
  name,
  icon,
}: {
  slug: string;
  entity: MqttEntity;
  name: string;
  icon: string;
}): Record<string, unknown> {
  const topics = entityTopics(slug, entity);

  return {
    name,
    unique_id: `inbox_${slug}_${entity}`,
    state_topic: topics.state,
    json_attributes_topic: topics.attributes,
    availability_topic: AVAILABILITY_TOPIC,
    // One HA device per opted-in account, so the privacy boundary stays visible
    // in Home Assistant rather than merging several people's mail into one.
    device: {
      identifiers: [`inbox_${slug}`],
      name: `Inbox – ${slug}`,
      manufacturer: "Dhara AI",
      model: "email-agent",
    },
    icon,
  };
}

export function unreadPayload({
  unread,
  total,
}: {
  unread: number;
  total: number;
}) {
  return { state: String(unread), attributes: { total } };
}

export function urgentPayload({
  ruleName,
  countToday,
  at,
  detail,
}: {
  ruleName: string;
  countToday: number;
  at: string;
  /** Only supplied when the account has mqttIncludeDetail. */
  detail?: { subject: string; from: string };
}) {
  return {
    state: ruleName,
    attributes: { count_today: countToday, at, ...(detail ?? {}) },
  };
}

export function digestPayload({ items, at }: { items: number; at: string }) {
  return { state: "ready", attributes: { items, at } };
}

export function approvalsPayload({
  pending,
  oldestWaitingSeconds,
  actions,
}: {
  pending: number;
  oldestWaitingSeconds: number | null;
  actions: string[];
}) {
  return {
    state: String(pending),
    attributes: { oldest_waiting_seconds: oldestWaitingSeconds, actions },
  };
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run utils/mqtt/topics.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/utils/mqtt/topics.ts apps/web/utils/mqtt/topics.test.ts
git commit -m "feat(mqtt): topic and payload construction, with the privacy rules pinned"
```

---

### Task 3: The connection

**Files:**
- Create: `apps/web/utils/mqtt/client.ts`
- Test: `apps/web/utils/mqtt/client.test.ts`

**Interfaces:**
- Consumes: `AVAILABILITY_TOPIC` from Task 2; `env.MQTT_*` from Task 1.
- Produces:
  - `isMqttConfigured(): boolean`
  - `publishMqtt(topic: string, payload: string, options?: { retain?: boolean }): void` — synchronous, never throws
  - `MAX_QUEUED_MESSAGES: 500`
  - `__resetMqttForTests(): void`

- [ ] **Step 1: Write the failing test**

Create `apps/web/utils/mqtt/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnv, mockConnect, fakeClient } = vi.hoisted(() => {
  const fake = {
    connected: false,
    publish: vi.fn(),
    on: vi.fn(),
    end: vi.fn(),
  };
  return {
    mockEnv: {
      MQTT_HOST: "broker.test",
      MQTT_PORT: 1883,
      MQTT_USERNAME: "u",
      MQTT_PASSWORD: "p",
    } as Record<string, unknown>,
    mockConnect: vi.fn().mockReturnValue(fake),
    fakeClient: fake,
  };
});

vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("mqtt", () => ({ default: { connect: mockConnect } }));

import {
  __resetMqttForTests,
  MAX_QUEUED_MESSAGES,
  isMqttConfigured,
  publishMqtt,
} from "./client";

beforeEach(() => {
  vi.clearAllMocks();
  fakeClient.connected = false;
  __resetMqttForTests();
  mockEnv.MQTT_HOST = "broker.test";
});

describe("mqtt client", () => {
  it("is inert when no broker is configured", () => {
    mockEnv.MQTT_HOST = undefined;
    __resetMqttForTests();

    expect(isMqttConfigured()).toBe(false);
    publishMqtt("inbox/x/state", "1");

    expect(mockConnect).not.toHaveBeenCalled();
  });

  /**
   * Two connections sharing a client id make the broker disconnect the first,
   * which presents as an endless reconnect loop rather than an error.
   */
  it("connects with a client id unique to this process", () => {
    publishMqtt("inbox/x/state", "1");

    const { clientId } = mockConnect.mock.calls[0][1];
    expect(clientId).toMatch(new RegExp(`^inbox-${process.pid}-[a-z0-9]+$`));
  });

  it("registers a last will so the broker announces our death", () => {
    publishMqtt("inbox/x/state", "1");

    expect(mockConnect.mock.calls[0][1].will).toMatchObject({
      topic: "inbox/availability",
      payload: "offline",
      retain: true,
    });
  });

  it("publishes straight through once connected", () => {
    publishMqtt("inbox/x/state", "1");
    fakeClient.connected = true;
    publishMqtt("inbox/x/state", "2", { retain: true });

    expect(fakeClient.publish).toHaveBeenCalledWith(
      "inbox/x/state",
      "2",
      { qos: 1, retain: true },
      expect.any(Function),
    );
  });

  /**
   * The whole point of the module. A broker outage must leave mail processing
   * untouched — this path is a notification plane, not a security control, so
   * it fails soft where the approval gate fails closed.
   */
  it("never throws when the broker is unreachable", () => {
    fakeClient.connected = true;
    fakeClient.publish.mockImplementation(() => {
      throw new Error("broker gone");
    });

    expect(() => publishMqtt("inbox/x/state", "1")).not.toThrow();
  });

  it("bounds the queue so an outage cannot grow memory without limit", () => {
    for (let i = 0; i < MAX_QUEUED_MESSAGES + 50; i++) {
      publishMqtt(`inbox/x/${i}`, "1");
    }

    fakeClient.connected = true;
    const connectHandler = fakeClient.on.mock.calls.find(
      ([event]) => event === "connect",
    )?.[1] as () => void;
    connectHandler();

    // availability + the capped queue, oldest dropped.
    expect(fakeClient.publish.mock.calls.length).toBe(MAX_QUEUED_MESSAGES + 1);
    const topics = fakeClient.publish.mock.calls.map(([t]) => t);
    expect(topics).not.toContain("inbox/x/0");
    expect(topics).toContain(`inbox/x/${MAX_QUEUED_MESSAGES + 49}`);
  });

  it("announces itself online when it connects", () => {
    publishMqtt("inbox/x/state", "1");
    fakeClient.connected = true;
    const connectHandler = fakeClient.on.mock.calls.find(
      ([event]) => event === "connect",
    )?.[1] as () => void;
    connectHandler();

    expect(fakeClient.publish).toHaveBeenCalledWith(
      "inbox/availability",
      "online",
      { qos: 1, retain: true },
      expect.any(Function),
    );
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run utils/mqtt/client.test.ts`
Expected: FAIL — `Cannot find module './client'`

- [ ] **Step 3: Implement**

Create `apps/web/utils/mqtt/client.ts`:

```ts
import "server-only";
import mqtt, { type MqttClient } from "mqtt";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { AVAILABILITY_TOPIC } from "@/utils/mqtt/topics";

/**
 * The broker connection.
 *
 * Fails SOFT, deliberately the opposite of the approval gate. That gate fails
 * closed because it is a security control; this is a notification plane, so a
 * broker outage must leave mail processing completely untouched. Nothing here
 * throws into a caller, and no caller ever waits on the broker.
 */

const logger = createScopedLogger("mqtt");

/** Bounded so an outage cannot grow memory without limit. */
export const MAX_QUEUED_MESSAGES = 500;

type Queued = { topic: string; payload: string; retain: boolean };

let client: MqttClient | null = null;
let queue: Queued[] = [];
let lastLoggedState: string | null = null;

export function isMqttConfigured(): boolean {
  return Boolean(env.MQTT_HOST && env.MQTT_USERNAME && env.MQTT_PASSWORD);
}

export function publishMqtt(
  topic: string,
  payload: string,
  options: { retain?: boolean } = {},
): void {
  if (!isMqttConfigured()) return;

  const message = { topic, payload, retain: options.retain ?? false };

  try {
    const connection = ensureClient();

    if (connection?.connected) {
      send(connection, message);
      return;
    }

    enqueue(message);
  } catch (error) {
    // Includes a failure to construct the client at all.
    logger.warn("Dropped an MQTT message", { topic, error });
  }
}

function ensureClient(): MqttClient | null {
  if (client) return client;

  // Sharing a client id makes the broker disconnect the older connection, which
  // looks like an endless reconnect loop rather than a configuration mistake.
  const clientId = `inbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  client = mqtt.connect(`mqtt://${env.MQTT_HOST}:${env.MQTT_PORT ?? 1883}`, {
    clientId,
    username: env.MQTT_USERNAME,
    password: env.MQTT_PASSWORD,
    reconnectPeriod: 5000,
    connectTimeout: 10_000,
    // Our own bounded queue is the buffer; mqtt.js's unbounded one is not.
    queueQoSZero: false,
    will: {
      topic: AVAILABILITY_TOPIC,
      payload: "offline",
      qos: 1,
      retain: true,
    },
  });

  client.on("connect", () => {
    logState("connected");
    send(client as MqttClient, {
      topic: AVAILABILITY_TOPIC,
      payload: "online",
      retain: true,
    });
    flush();
  });

  // Logged once per state change, not per publish: an outage would otherwise
  // fill the log with one repeated line.
  // mqtt.js fires "connect" on CONNACK rather than on the TCP handshake, so
  // reaching it does mean the broker accepted us. The refusal path is the one
  // that lies: a broker that completes TCP and then answers "Not authorized"
  // surfaces only here, as an error carrying the return code. Log the code, or
  // the logs will claim a connection that was refused. Verified during design:
  // this broker answers CONNACK 5 to an unknown user.
  client.on("error", (error) =>
    logState("error", { message: error.message, code: (error as { code?: number }).code }),
  );
  client.on("offline", () => logState("offline"));

  return client;
}

function send(connection: MqttClient, message: Queued) {
  try {
    connection.publish(
      message.topic,
      message.payload,
      { qos: 1, retain: message.retain },
      (error) => {
        if (error) logger.warn("MQTT publish failed", { topic: message.topic });
      },
    );
  } catch (error) {
    logger.warn("MQTT publish threw", { topic: message.topic, error });
  }
}

function enqueue(message: Queued) {
  queue.push(message);

  if (queue.length > MAX_QUEUED_MESSAGES) {
    queue = queue.slice(-MAX_QUEUED_MESSAGES);
    logState("queue-full");
  }
}

function flush() {
  const pending = queue;
  queue = [];

  for (const message of pending) {
    send(client as MqttClient, message);
  }
}

function logState(state: string, error?: unknown) {
  if (state === lastLoggedState) return;
  lastLoggedState = state;
  logger.info("MQTT connection state", { state, error });
}

/** Test seam: the module is a singleton by design. */
export function __resetMqttForTests() {
  client?.end?.(true);
  client = null;
  queue = [];
  lastLoggedState = null;
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run utils/mqtt/client.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Prove the fail-soft guarantee is load-bearing**

`publishMqtt` has two catches and only one is load-bearing here: the outer one
guards client construction, while the catch inside `send()` is what makes a
failing `connection.publish` survivable. Break the one in `send()` — replace its
`catch` body with `throw error` — re-run, and confirm
`never throws when the broker is unreachable` fails. Restore it.

- [ ] **Step 6: Prove fail-soft is not hiding a bug in itself**

This is the trap that costs people days. A module whose every error is swallowed
can contain a plain coding mistake — a missing import, a typo — and report
perfect health while publishing nothing, forever. A mock that throws does not
catch this, because the mock proves only that *our* catch works, not that the
real code path executes.

Create `apps/web/scripts/mqtt-selftest.mjs`, which runs the REAL module against
an unroutable address and asserts a positive outcome, not merely the absence of
a throw:

```js
// Usage: node scripts/mqtt-selftest.mjs
// Exits non-zero if the fail-soft path is broken OR silently inert.
import mqtt from "mqtt";

// TEST-NET-1: reserved by RFC 5737, guaranteed unroutable. Connecting here
// exercises the real failure path rather than a mocked one.
const client = mqtt.connect("mqtt://192.0.2.1:1883", {
  connectTimeout: 2000,
  reconnectPeriod: 0,
});

let errored = false;
client.on("error", () => {
  errored = true;
});

setTimeout(() => {
  client.end(true);
  if (!errored) {
    console.error("FAIL: unroutable broker produced no error event");
    process.exit(1);
  }
  console.log("OK: unroutable broker surfaces an error rather than hanging");
  process.exit(0);
}, 4000);
```

Run: `cd /mnt/projects/inbox/apps/web && node scripts/mqtt-selftest.mjs`
Expected: `OK: ...`, exit 0.

Then add this test to `client.test.ts`, which is the half a mock CAN catch —
that the module actually reaches `mqtt.connect` rather than returning early on
some internal error:

```ts
  /**
   * Fail-soft can hide a bug in itself: a missing import or a typo inside
   * publishMqtt would be swallowed by the very catch that makes publishing
   * safe, and the module would report health while publishing nothing forever.
   * Asserting the real call happened is the guard against silent inertness.
   */
  it("actually reaches the broker client rather than failing silently", () => {
    publishMqtt("inbox/x/state", "1");

    expect(mockConnect).toHaveBeenCalledTimes(1);
  });

- [ ] **Step 7: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/utils/mqtt/client.ts apps/web/utils/mqtt/client.test.ts apps/web/scripts/mqtt-selftest.mjs
git commit -m "feat(mqtt): a fail-soft broker connection with a bounded queue"
```

---

### Task 4: Move the existing rules off the Home Assistant proxy

No behaviour change visible to Home Assistant — same topics, same payloads, one
fewer dependency.

**Files:**
- Modify: `apps/web/utils/home-assistant.ts` (`executeMqttPublish`)
- Test: `apps/web/utils/home-assistant.test.ts` (create if absent)

**Interfaces:**
- Consumes: `publishMqtt` from Task 3.

- [ ] **Step 1: Write the failing test**

Create or extend `apps/web/utils/home-assistant.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: () => true,
}));

import { executeHomeAssistantAction } from "./home-assistant";

beforeEach(() => vi.clearAllMocks());

describe("home assistant mqtt action", () => {
  /**
   * These three topics have HA automations wired to them. The payload shape is
   * a published contract — only the transport is allowed to change.
   */
  it("publishes the same payload it used to send via the HA REST proxy", async () => {
    await executeHomeAssistantAction({
      config: { type: "mqtt", mqttTopic: "homeassistant/inbox/urgent" },
      email: {
        threadId: "t1",
        messageId: "m1",
        subject: "Invoice due",
        from: "billing@vendor.com",
        headerMessageId: "<h1>",
        snippet: "Payment",
        labels: ["INBOX"],
        receivedAt: new Date("2026-09-07T05:00:00.000Z"),
      },
      rule: { id: "r1", ruleId: "r1", ruleName: "Urgent" },
      executedRule: { automated: true },
      emailAccountId: "acct-1",
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const [topic, raw] = mockPublish.mock.calls[0];
    expect(topic).toBe("homeassistant/inbox/urgent");

    expect(JSON.parse(raw)).toMatchObject({
      from: "billing@vendor.com",
      subject: "Invoice due",
      snippet: "Payment",
      thread_id: "t1",
      message_id: "m1",
      labels: ["INBOX"],
      received_at: "2026-09-07T05:00:00.000Z",
      rule_name: "Urgent",
      rule_id: "r1",
      automated: true,
    });
  });
});
```

Adjust the `executeHomeAssistantAction` call signature to match the real export
in `utils/home-assistant.ts` before running — read the file first.

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run utils/home-assistant.test.ts`
Expected: FAIL — `mockPublish` not called (still going through `fetch`).

- [ ] **Step 3: Replace the transport**

In `apps/web/utils/home-assistant.ts`, replace the body of `executeMqttPublish`
after the `payload` object is built. Delete the `url`, `fetch`/`Promise.race`
block and the surrounding try/catch, and replace with:

```ts
  // Published directly rather than asking Home Assistant to do it. The old path
  // POSTed to /api/services/mqtt/publish, so every notification depended on HA
  // being up and on a per-user long-lived token. Same topic, same payload — only
  // the transport changed, so existing HA automations do not notice.
  publishMqtt(topic, JSON.stringify(payload));
  logger.info("MQTT published", { topic });
```

`haUrl` and `token` become unused parameters — remove them from the signature
and from the call site at `utils/home-assistant.ts:83`.

Add at the top of the file:

```ts
import { publishMqtt } from "@/utils/mqtt/client";
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run utils/home-assistant.test.ts`
Expected: PASS

- [ ] **Step 5: Verify nothing else broke**

```bash
cd /mnt/projects/inbox/apps/web
npx vitest run && npx tsc --noEmit -p tsconfig.build.json && node scripts/typecheck-ratchet.mjs
```
Expected: all pass; ratchet reports `0 total (0 in source)`.

- [ ] **Step 6: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/utils/home-assistant.ts apps/web/utils/home-assistant.test.ts
git commit -m "refactor(mqtt): publish rule notifications directly instead of via Home Assistant"
```

---

### Task 5: Per-account opt-in columns

**Files:**
- Modify: `apps/web/prisma/schema.prisma` (`model EmailAccount`)
- Create: `apps/web/prisma/migrations/<timestamp>_email_account_mqtt/migration.sql`

**Interfaces:**
- Produces: `EmailAccount.mqttEnabled`, `.mqttTopicSlug`, `.mqttIncludeDetail`.

- [ ] **Step 1: Add the columns**

In `model EmailAccount`:

```prisma
  /// MQTT agent bus. Off by default: this instance is not single-tenant, and
  /// anything holding the broker password can read every topic on it.
  mqttEnabled Boolean @default(false)

  /// Topic label, so no email address ever appears in a topic string. Unique
  /// because two accounts choosing "work" would silently merge one person's
  /// events into another's.
  mqttTopicSlug String? @unique

  /// Separate, explicit consent for subjects and senders in payloads.
  mqttIncludeDetail Boolean @default(false)
```

- [ ] **Step 2: Generate the migration**

`prisma migrate dev` is interactive and fails in this environment. Use diff:

```bash
cd /mnt/projects/inbox/apps/web
npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script \
  | grep -v '^Loaded Prisma config' > /tmp/mqtt-mig.sql
cat /tmp/mqtt-mig.sql
```

Expected: only `ALTER TABLE "EmailAccount" ADD COLUMN ...` plus one
`CREATE UNIQUE INDEX`. **If any other table appears, stop** — that is unrelated
drift and must be investigated before applying.

- [ ] **Step 3: Apply it**

```bash
DIR="prisma/migrations/$(date +%Y%m%d%H%M%S)_email_account_mqtt"
mkdir -p "$DIR" && cp /tmp/mqtt-mig.sql "$DIR/migration.sql"
npx prisma migrate deploy && npx prisma generate
```

- [ ] **Step 4: Verify against the database**

```bash
PGPASSWORD=... psql -h nuc.lan -U inbox_zero_user -d inbox_zero_db -tAc \
  "select column_name from information_schema.columns
   where table_name='EmailAccount' and column_name like 'mqtt%';"
```
Expected: `mqttEnabled`, `mqttIncludeDetail`, `mqttTopicSlug`

- [ ] **Step 5: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/prisma/schema.prisma apps/web/prisma/migrations
git commit -m "feat(mqtt): per-account opt-in for the agent bus"
```

---

### Task 6: The four publishers

**Files:**
- Create: `apps/web/utils/mqtt/events.ts`
- Test: `apps/web/utils/mqtt/events.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2, 3, 5.
- Produces:
  - `publishUnread({ emailAccountId, unread, total }): Promise<void>`
  - `publishUrgent({ emailAccountId, ruleName, subject, from }): Promise<void>`
  - `publishDigest({ emailAccountId, items }): Promise<void>`
  - `publishApprovals({ emailAccountId, pending, oldestWaitingSeconds, actions }): Promise<void>`
  - `clearAccountTopics(slug: string): void`

All four resolve without throwing when the account has not opted in.

- [ ] **Step 1: Write the failing test**

Create `apps/web/utils/mqtt/events.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPublish, mockPrisma } = vi.hoisted(() => ({
  mockPublish: vi.fn(),
  mockPrisma: { emailAccount: { findUnique: vi.fn() } },
}));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: () => true,
}));
vi.mock("@/utils/prisma", () => ({ default: mockPrisma }));

import { publishUnread, publishUrgent } from "./events";

const optedIn = {
  mqttEnabled: true,
  mqttTopicSlug: "work",
  mqttIncludeDetail: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.emailAccount.findUnique.mockResolvedValue(optedIn);
});

describe("mqtt events", () => {
  it("publishes state, attributes and a discovery config", async () => {
    await publishUnread({ emailAccountId: "a1", unread: 512, total: 865 });

    const topics = mockPublish.mock.calls.map(([t]) => t);
    expect(topics).toEqual(
      expect.arrayContaining([
        "inbox/work/unread/state",
        "inbox/work/unread/attributes",
        "homeassistant/sensor/inbox_work/unread/config",
      ]),
    );
    for (const [, , options] of mockPublish.mock.calls) {
      expect(options).toMatchObject({ retain: true });
    }
  });

  /** Off by default. Other people's mail must not reach the bus. */
  it("publishes nothing for an account that has not opted in", async () => {
    mockPrisma.emailAccount.findUnique.mockResolvedValue({
      ...optedIn,
      mqttEnabled: false,
    });

    await publishUnread({ emailAccountId: "a1", unread: 1, total: 2 });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("publishes nothing when the slug is missing or invalid", async () => {
    mockPrisma.emailAccount.findUnique.mockResolvedValue({
      ...optedIn,
      mqttTopicSlug: "not a slug",
    });

    await publishUnread({ emailAccountId: "a1", unread: 1, total: 2 });

    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("withholds subject and sender unless the account asked for detail", async () => {
    await publishUrgent({
      emailAccountId: "a1",
      ruleName: "Urgent",
      subject: "Invoice",
      from: "billing@vendor.com",
    });

    const attributes = mockPublish.mock.calls.find(([t]) =>
      t.endsWith("/urgent/attributes"),
    )?.[1];
    expect(attributes).not.toMatch(/Invoice/);
    expect(attributes).not.toMatch(/vendor\.com/);
  });

  it("includes them when it did", async () => {
    mockPrisma.emailAccount.findUnique.mockResolvedValue({
      ...optedIn,
      mqttIncludeDetail: true,
    });

    await publishUrgent({
      emailAccountId: "a1",
      ruleName: "Urgent",
      subject: "Invoice",
      from: "billing@vendor.com",
    });

    const attributes = mockPublish.mock.calls.find(([t]) =>
      t.endsWith("/urgent/attributes"),
    )?.[1];
    expect(attributes).toMatch(/Invoice/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run utils/mqtt/events.test.ts`
Expected: FAIL — `Cannot find module './events'`

- [ ] **Step 3: Implement**

Create `apps/web/utils/mqtt/events.ts`:

```ts
import "server-only";
import { createScopedLogger } from "@/utils/logger";
import { isMqttConfigured, publishMqtt } from "@/utils/mqtt/client";
import {
  approvalsPayload,
  digestPayload,
  discoveryConfig,
  entityTopics,
  isValidSlug,
  type MqttEntity,
  unreadPayload,
  urgentPayload,
} from "@/utils/mqtt/topics";
import prisma from "@/utils/prisma";

/**
 * The four things Inbox tells the bus.
 *
 * Every publisher resolves opt-in first and builds nothing otherwise, so an
 * account that never enabled the bus cannot leak through a publisher added
 * later.
 */

const logger = createScopedLogger("mqtt-events");

const ENTITY_META: Record<MqttEntity, { name: string; icon: string }> = {
  unread: { name: "Unread", icon: "mdi:email" },
  urgent: { name: "Last urgent mail", icon: "mdi:alert" },
  digest: { name: "Digest", icon: "mdi:newspaper" },
  approvals: { name: "Pending approvals", icon: "mdi:account-check" },
};

type Consent = { slug: string; includeDetail: boolean };

async function consentFor(emailAccountId: string): Promise<Consent | null> {
  if (!isMqttConfigured()) return null;

  const account = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      mqttEnabled: true,
      mqttTopicSlug: true,
      mqttIncludeDetail: true,
    },
  });

  if (!account?.mqttEnabled) return null;

  const slug = account.mqttTopicSlug;

  // A malformed slug would corrupt the topic string, so refuse rather than
  // publish somewhere unintended.
  if (!slug || !isValidSlug(slug)) {
    logger.warn("Skipping MQTT publish: account has no usable topic slug", {
      emailAccountId,
    });
    return null;
  }

  return { slug, includeDetail: account.mqttIncludeDetail };
}

function publishEntity(
  slug: string,
  entity: MqttEntity,
  built: { state: string; attributes: Record<string, unknown> },
) {
  const meta = ENTITY_META[entity];

  // A typo should be loud, not quietly register an entity nothing announced
  // and that no dashboard will ever explain.
  if (!meta) {
    logger.error("Refusing to publish an unknown MQTT entity", { entity });
    return;
  }

  const topics = entityTopics(slug, entity);

  // Retained throughout: a subscriber connecting at noon should learn current
  // state immediately rather than waiting for the next change.
  publishMqtt(
    topics.config,
    JSON.stringify(discoveryConfig({ slug, entity, ...meta })),
    { retain: true },
  );
  publishMqtt(topics.state, built.state, { retain: true });
  publishMqtt(topics.attributes, JSON.stringify(built.attributes), {
    retain: true,
  });
}

export async function publishUnread({
  emailAccountId,
  unread,
  total,
}: {
  emailAccountId: string;
  unread: number;
  total: number;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(consent.slug, "unread", unreadPayload({ unread, total }));
}

export async function publishUrgent({
  emailAccountId,
  ruleName,
  subject,
  from,
}: {
  emailAccountId: string;
  ruleName: string;
  subject: string;
  from: string;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "urgent",
    urgentPayload({
      ruleName,
      countToday: 1,
      at: new Date().toISOString(),
      ...(consent.includeDetail ? { detail: { subject, from } } : {}),
    }),
  );
}

export async function publishDigest({
  emailAccountId,
  items,
}: {
  emailAccountId: string;
  items: number;
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "digest",
    digestPayload({ items, at: new Date().toISOString() }),
  );
}

export async function publishApprovals({
  emailAccountId,
  pending,
  oldestWaitingSeconds,
  actions,
}: {
  emailAccountId: string;
  pending: number;
  oldestWaitingSeconds: number | null;
  actions: string[];
}): Promise<void> {
  const consent = await consentFor(emailAccountId);
  if (!consent) return;

  publishEntity(
    consent.slug,
    "approvals",
    approvalsPayload({ pending, oldestWaitingSeconds, actions }),
  );
}

/**
 * Retained topics outlive the account that made them: opting out or renaming a
 * slug would otherwise leave stale topics and orphaned Home Assistant entities
 * forever. An empty retained payload is how MQTT deletes one.
 */
export function clearAccountTopics(slug: string): void {
  for (const entity of Object.keys(ENTITY_META) as MqttEntity[]) {
    const topics = entityTopics(slug, entity);
    publishMqtt(topics.config, "", { retain: true });
    publishMqtt(topics.state, "", { retain: true });
    publishMqtt(topics.attributes, "", { retain: true });
  }
}
```

- [ ] **Step 4: Run the tests and make sure they pass**

Run: `npx vitest run utils/mqtt/events.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/utils/mqtt/events.ts apps/web/utils/mqtt/events.test.ts
git commit -m "feat(mqtt): the four bus publishers, gated on per-account consent"
```

---

### Task 7: Wire the publishers to their triggers

**Files:**
- Modify: `apps/web/utils/home-assistant.ts` — call `publishUrgent` alongside the
  legacy topic publish
- Modify: `apps/web/app/api/cron/a2a-digest/route.ts` — call `publishDigest`
- Modify: `apps/web/utils/a2a/protocol-handler.ts` — call `publishApprovals`
  after an approval is created and after one is withdrawn
- Modify: `apps/web/app/api/cron/process-emails/route.ts` — call `publishUnread`

**Interfaces:**
- Consumes: all four publishers from Task 6.

Each call site is one `await`, wrapped so a publish failure cannot affect the
work it is reporting on:

```ts
await publishUrgent({
  emailAccountId,
  ruleName: rule.ruleName ?? "",
  subject: email.subject,
  from: email.from,
}).catch(() => {});
```

The `.catch(() => {})` is deliberate and belongs at every call site: `publishMqtt`
itself cannot throw, but `consentFor` does a database read, and a database blip
must not fail a rule execution or a cron run.

- [ ] **Step 1: Read each call site before editing**

```bash
cd /mnt/projects/inbox/apps/web
sed -n '60,110p' utils/home-assistant.ts
grep -n "digest" app/api/cron/a2a-digest/route.ts | head -20
grep -n "a2aApproval.create\|a2aApproval.updateMany" utils/a2a/protocol-handler.ts
```

- [ ] **Step 2: Add the urgent publish**

In `utils/home-assistant.ts`, immediately after the `publishMqtt(topic, ...)`
line added in Task 4 — so the bus gets a PII-free event alongside the legacy
topic's full payload:

```ts
  // The legacy topic above keeps its full payload because an operator chose it
  // for their own account. The bus is a broadcast, so it gets the consent-gated
  // version instead. The catch is load-bearing: consentFor does a database read,
  // and a database blip must not fail a rule execution.
  await publishUrgent({
    emailAccountId,
    ruleName: rule.ruleName ?? "",
    subject: email.subject,
    from: email.from,
  }).catch(() => {});
```

`executeMqttPublish` does not currently receive `emailAccountId`; thread it down
from `executeHomeAssistantAction`, which already resolves the account.

- [ ] **Step 3: Add the remaining three, one at a time**

Same `.catch(() => {})` shape at each. After each single call site, run the
relevant test file and confirm it still passes before adding the next:

- `publishDigest({ emailAccountId, items })` after the digest cron finishes
  generating, where the item count is known.
- `publishApprovals({ emailAccountId, pending, oldestWaitingSeconds, actions })`
  after `prisma.a2aApproval.create` in `handleMessageSend`, and after the
  withdrawal `updateMany` in `handleTaskCancel`. Both need a count query for the
  account's remaining pending approvals.
- `publishUnread({ emailAccountId, unread, total })` in the process-emails cron,
  from the same provider stats call `getInboxStatsForChatContext` uses.

- [ ] **Step 4: Run the full suite**

```bash
npx vitest run && npx tsc --noEmit -p tsconfig.build.json
```
Expected: all pass, no type errors.

- [ ] **Step 5: Commit**

```bash
cd /mnt/projects/inbox
git add apps/web/utils/home-assistant.ts apps/web/app/api/cron apps/web/utils/a2a/protocol-handler.ts
git commit -m "feat(mqtt): publish unread, urgent, digest and approval state to the bus"
```

---

### Task 8: Opt-in UI

**Files:**
- Modify: `apps/web/app/(app)/[emailAccountId]/settings/HomeAssistantSection.tsx`
  or a sibling `MqttSection.tsx` following the same pattern
- Modify: `apps/web/utils/actions/settings.validation.ts` (or the nearest
  existing settings validation file)

Follow `.claude/skills/fullstack-workflow/SKILL.md`: server action with
`next-safe-action`, Zod schema, `useAction`, `LoadingContent`.

- [ ] **Step 1: Read the existing section as the template**

```bash
cd /mnt/projects/inbox/apps/web
cat "app/(app)/[emailAccountId]/settings/HomeAssistantSection.tsx"
```

- [ ] **Step 2: Add three fields**

Enable toggle, slug text input, include-detail toggle. The slug field must
validate against the same `^[a-z0-9][a-z0-9_-]{0,30}$` used in `topics.ts`, and
the form must surface the unique-constraint violation as "that name is already
taken" rather than a raw Prisma error.

- [ ] **Step 3: Clear retained topics when an account opts out**

In the server action, when `mqttEnabled` goes true → false, or when the slug
changes, call `clearAccountTopics(previousSlug)` first. Without this, a renamed
or disabled account leaves orphaned Home Assistant entities that never
disappear.

- [ ] **Step 4: Run the suite and commit**

```bash
npx vitest run
cd /mnt/projects/inbox && git add apps/web/app apps/web/utils/actions
git commit -m "feat(mqtt): settings UI for per-account bus opt-in"
```

---

### Task 9: Live verification

Not a code task. Nothing here is believed until it is observed on the real
broker.

- [ ] **Step 1: Build and deploy**

```bash
cd /mnt/projects/inbox
docker compose -f docker-compose.prod.yml build web
docker compose -f docker-compose.prod.yml up -d web cron
```

Wait for `https://inbox.sudiptadhara.in/api/health` to return 200.

- [ ] **Step 2: Confirm the container can see the config**

```bash
docker exec inbox-prod-web-1 printenv | grep -c '^MQTT_'
```
Expected: `4`

- [ ] **Step 3: Opt one account in**

Use the settings UI on `admin@sudiptadhara.in` with slug `admin`.

- [ ] **Step 4: Watch the bus**

Subscribe with the probe already written during design:

The design probe used a minimal MQTT client because neither `mosquitto_sub` nor
an npm client is installed on this host. Recreate it once at
`/mnt/projects/inbox/apps/web/scripts/mqtt-watch.mjs` so verification is
repeatable, using the `mqtt` dependency added in Task 1:

```js
// Usage: node scripts/mqtt-watch.mjs 'inbox/#' 20
import mqtt from "mqtt";

const [filter = "inbox/#", seconds = "15"] = process.argv.slice(2);
const client = mqtt.connect(
  `mqtt://${process.env.MQTT_HOST}:${process.env.MQTT_PORT ?? 1883}`,
  { username: process.env.MQTT_USERNAME, password: process.env.MQTT_PASSWORD },
);

client.on("connect", () => {
  client.subscribe(filter);
  setTimeout(() => client.end(true, () => process.exit(0)), Number(seconds) * 1000);
});
client.on("message", (topic, payload) =>
  console.log(`${topic}\n    ${payload.toString().slice(0, 300)}\n`),
);
client.on("error", (error) => {
  console.error("mqtt error:", error.message);
  process.exit(1);
});
```

```bash
cd /mnt/projects/inbox/apps/web
set -a; . /mnt/projects/inbox/.env; set +a
node scripts/mqtt-watch.mjs 'inbox/#' 20
```

Expected: `inbox/availability` = `online`, plus `inbox/admin/<entity>/state` and
`/attributes` for each entity that has fired.

- [ ] **Step 5: Confirm Home Assistant picked up the entities**

```bash
node scripts/mqtt-watch.mjs 'homeassistant/sensor/inbox_admin/#' 10
```
Expected: one retained `config` per entity. Then check Home Assistant shows a
device named `Inbox – admin`.

- [ ] **Step 6: Prove the last will fires**

`docker stop` sends SIGTERM, and a graceful shutdown sends a DISCONNECT — which
tells the broker NOT to fire the will. A graceful path never exercises the will,
so testing that way proves nothing. Sever the socket instead:

```bash
node scripts/mqtt-watch.mjs 'inbox/availability' 12 &
docker kill inbox-prod-web-1 && sleep 8   # SIGKILL: no DISCONNECT is sent
docker compose -f docker-compose.prod.yml up -d web
```
Expected: `offline` while stopped, `online` again after restart. This is the
death detection no HTTP webhook can provide, so it is worth confirming rather
than assuming.

- [ ] **Step 7: Confirm the legacy rules still work unchanged**

Trigger (or wait for) one of the three existing rules and confirm the payload on
`homeassistant/inbox/urgent` is byte-identical to the pre-change shape, and that
any HA automation bound to it still fires.

- [ ] **Step 8: Confirm opt-out cleans up**

Disable the bus for the account, then re-subscribe to
`homeassistant/sensor/inbox_admin/#` and confirm the retained configs are gone
and the HA device disappears.

---

### Task 10: Service health entities

Added after Task 1, from the SlackAgent implementation notes: *"find what your
code already knows and throws away; that list is your entity set."*

A pass over the codebase found four things already computed and then dropped
into a log nobody reads:

| Already computed | Where it goes today |
|---|---|
| `reportA2aTokenHygiene()` — expiring and stale peer tokens | log only |
| `logger.info("Agent run finished", …)` — steps, tool sequence, repeated calls, answered, hit-cap | log only |
| A2A task terminal states — completed vs failed | log only |
| Long-memory / DharaHIL reachability | swallowed warns |

These are **service-level, not per-account**: no mail content, no addresses, no
PII. So they need no opt-in, no slug and no consent lookup — which makes them
cheaper than Tasks 5–8, not more expensive. They mirror SlackAgent's own three
entities (`dependencies`, `peer_mitra`, `task_outcomes`), which is the whole
point: the bus is for agent health, and content was the addition.

Scope discipline: one entity per question a person would actually ask, not one
per metric.

| Entity | Question it answers | state | attributes |
|---|---|---|---|
| `dependencies` | Is anything Inbox needs broken? | count unhealthy | `{ unhealthy: string[] }` |
| `peers` | Are my A2A credentials about to lapse? | count configured | `{ expiring: string[], stale: string[] }` |
| `agent_runs` | Are agent runs healthy? | last outcome | `{ steps, repeated_tool_calls, answered, hit_step_cap }` |

**Files:**
- Modify: `apps/web/utils/mqtt/topics.ts` — add a `ServiceEntity` type and
  `serviceTopics()` / `serviceDiscoveryConfig()` under device `inbox`
- Modify: `apps/web/utils/mqtt/events.ts` — `publishServiceHealth()`
- Modify: `apps/web/utils/ai/assistant/chat.ts:435` — publish alongside the
  existing run-summary log, not instead of it
- Modify: `apps/web/app/api/cron/a2a-tasks/route.ts` — publish dependencies and
  peers on each cron pass, reusing `reportA2aTokenHygiene()`
- Test: `apps/web/utils/mqtt/service-health.test.ts`

**Interfaces:**
- Consumes: `publishMqtt` (Task 3), `discoveryConfig` shape (Task 2).
- Produces: `publishServiceHealth(entity: ServiceEntity, state: string, attributes: Record<string, unknown>): void`

Device block for all three, distinct from the per-account devices:

```json
{
  "identifiers": ["inbox"],
  "name": "Inbox",
  "manufacturer": "Dhara AI",
  "model": "email-agent"
}
```

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: () => true,
}));

import { publishServiceHealth } from "./events";

describe("service health", () => {
  it("publishes state, attributes and discovery under the service device", () => {
    publishServiceHealth("dependencies", "0", { unhealthy: [] });

    const topics = mockPublish.mock.calls.map(([t]) => t);
    expect(topics).toEqual([
      "homeassistant/sensor/inbox/dependencies/config",
      "inbox/dependencies/state",
      "inbox/dependencies/attributes",
    ]);
  });

  /** No account, no mail, no addresses — this is why it needs no opt-in. */
  it("carries no per-account identity", () => {
    publishServiceHealth("peers", "2", { expiring: ["OpenClaw-Mitra"] });

    expect(JSON.stringify(mockPublish.mock.calls)).not.toMatch(/@/);
  });

  /** A typo must be loud, not silently register an entity nothing announced. */
  it("refuses an unknown entity", () => {
    mockPublish.mockClear();
    // @ts-expect-error deliberately invalid entity key
    publishServiceHealth("nonsense", "1", {});

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run utils/mqtt/service-health.test.ts`
Expected: FAIL — `publishServiceHealth is not a function`

- [ ] **Step 3: Implement, following the existing `publishEntity` shape**

Reuse the retained-publish ordering (config, state, attributes) and the
unknown-key guard already written in Task 6. Do not duplicate `publishEntity` —
extract the shared body so both the per-account and service paths use it.

- [ ] **Step 4: Wire the three sources**

`agent_runs` from the existing summary in `chat.ts` (publish *alongside* the
log, so the log keeps working when MQTT is unconfigured). `dependencies` and
`peers` from the a2a-tasks cron, reusing `reportA2aTokenHygiene()`. Each call
gets `.catch(() => {})` per the Global Constraints.

- [ ] **Step 5: Run the suite and commit**

```bash
npx vitest run && npx tsc --noEmit -p tsconfig.build.json
cd /mnt/projects/inbox
git add apps/web/utils/mqtt apps/web/utils/ai/assistant/chat.ts apps/web/app/api/cron/a2a-tasks/route.ts
git commit -m "feat(mqtt): publish service health the code already computed and discarded"
```

---

## Notes for the implementer

**Do not** add an MQTT subscribe path, an inbound command topic, or an approval
topic. Those are argued-against non-goals in the spec, not omissions — MQTT
authenticates a connection rather than a request, so a LAN topic that could
trigger actions would hand every action to anything holding the one password.

**Do not** change the three legacy topic names or their payload keys. HA
automations depend on them.

The new bus is PII-free by default while the legacy rule payloads carry `from`,
`subject` and `snippet`. That asymmetry is intentional: those are per-rule
actions an operator configured for their own account, whereas the bus is a
broadcast anything on the LAN can read.
