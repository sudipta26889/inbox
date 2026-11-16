import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPublish } = vi.hoisted(() => ({ mockPublish: vi.fn() }));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: () => true,
}));

import { publishServiceHealth } from "./events";

describe("service health", () => {
  it("publishes state, attributes and discovery under the service device", async () => {
    await publishServiceHealth("dependencies", "0", { unhealthy: [] });

    const topics = mockPublish.mock.calls.map(([t]) => t);
    expect(topics).toEqual([
      "homeassistant/sensor/inbox/dependencies/config",
      "inbox/dependencies/state",
      "inbox/dependencies/attributes",
    ]);
  });

  it("publishes retained, under the shared inbox device — not a per-account one", async () => {
    await publishServiceHealth("agent_runs", "answered", {
      steps: 3,
      repeated_tool_calls: 0,
      answered: true,
      hit_step_cap: false,
    });

    const config = mockPublish.mock.calls.find(([t]) =>
      t.endsWith("/agent_runs/config"),
    );
    expect(config?.[2]).toMatchObject({ retain: true });
    expect(JSON.parse(config?.[1] as string)).toMatchObject({
      device: {
        identifiers: ["inbox"],
        name: "Inbox",
        manufacturer: "Dhara AI",
        model: "email-agent",
      },
    });
  });

  /** No account, no mail, no addresses — this is why it needs no opt-in. */
  it("carries no per-account identity", async () => {
    await publishServiceHealth("peers", "2", { expiring: ["OpenClaw-Mitra"] });

    expect(JSON.stringify(mockPublish.mock.calls)).not.toMatch(/@/);
  });

  /** A typo must be loud, not silently register an entity nothing announced. */
  it("refuses an unknown entity", async () => {
    mockPublish.mockClear();
    // @ts-expect-error deliberately invalid entity key
    await publishServiceHealth("nonsense", "1", {});

    expect(mockPublish).not.toHaveBeenCalled();
  });
});
