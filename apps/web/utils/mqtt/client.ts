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

/**
 * Opens the broker connection at process boot (called from instrumentation.ts)
 * instead of waiting for the first publishMqtt call. Without this, the
 * "online" announcement — which only happens in ensureClient's connect
 * handler — doesn't fire until whatever cron job publishes next, leaving
 * inbox/availability reporting "offline" (the last will from the previous
 * process's death) for up to a cron period after a perfectly healthy restart.
 */
export function connectMqtt(): void {
  if (!isMqttConfigured()) return;

  try {
    ensureClient();
  } catch (error) {
    logger.warn("Failed to establish MQTT connection at boot", { error });
  }
}

function ensureClient(): MqttClient | null {
  if (client) return client;

  // Sharing a client id makes the broker disconnect the older connection, which
  // looks like an endless reconnect loop rather than a configuration mistake.
  const clientId = `inbox-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;

  client = mqtt.connect(`mqtt://${env.MQTT_HOST}:${env.MQTT_PORT || 1883}`, {
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
    logState("error", {
      message: error.message,
      code: (error as { code?: number }).code,
    }),
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
    queue.shift();
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
