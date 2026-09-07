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
});
