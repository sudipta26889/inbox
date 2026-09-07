import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import type { ExecutedRule } from "@/generated/prisma/client";

vi.mock("server-only", () => ({}));

const { mockPublish, mockIsMqttConfigured, mockPublishUrgent } = vi.hoisted(
  () => ({
    mockPublish: vi.fn().mockReturnValue(undefined),
    mockIsMqttConfigured: vi.fn().mockReturnValue(true),
    mockPublishUrgent: vi.fn().mockResolvedValue(undefined),
  }),
);
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: mockIsMqttConfigured,
}));
vi.mock("@/utils/mqtt/events", () => ({
  publishUrgent: mockPublishUrgent,
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from "@/utils/prisma";
import { executeHomeAssistantAction } from "./home-assistant";

const mockFindUnique = prisma.user.findUnique as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue({
    homeAssistantUrl: "http://ha.local:8123",
    homeAssistantToken: "token-1",
  });
  mockIsMqttConfigured.mockReturnValue(true);
  mockPublishUrgent.mockResolvedValue(undefined);
});

const email = {
  threadId: "t1",
  messageId: "m1",
  subject: "Invoice due",
  from: "billing@vendor.com",
  headerMessageId: "<h1>",
  snippet: "Payment",
  labels: ["INBOX"],
  receivedAt: new Date("2026-09-07T05:00:00.000Z"),
};
const rule = { id: "r1", ruleId: "r1", ruleName: "Urgent" };
const executedRule = {
  id: "er1",
  threadId: "t1",
  messageId: "m1",
  emailAccountId: "acct-1",
  automated: true,
  status: ExecutedRuleStatus.APPLIED,
} as ExecutedRule;

describe("home assistant mqtt action", () => {
  /**
   * These three topics have HA automations wired to them. The payload shape is
   * a published contract — only the transport is allowed to change.
   */
  it("publishes the same payload it used to send via the HA REST proxy", async () => {
    await executeHomeAssistantAction("user-1", email, rule, executedRule, {
      type: "mqtt",
      mqttTopic: "homeassistant/inbox/urgent",
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    const call = mockPublish.mock.calls[0];
    expect(call).toHaveLength(2); // no retain option
    const [topic, raw] = call;
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

  it("publishes over MQTT even when Home Assistant credentials are absent", async () => {
    mockFindUnique.mockResolvedValue({
      homeAssistantUrl: null,
      homeAssistantToken: null,
    });

    await executeHomeAssistantAction("user-1", email, rule, executedRule, {
      type: "mqtt",
      mqttTopic: "homeassistant/inbox/urgent",
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
  });

  it("throws a SafeError naming MQTT when MQTT is not configured", async () => {
    mockIsMqttConfigured.mockReturnValue(false);

    await expect(
      executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "mqtt",
        mqttTopic: "homeassistant/inbox/urgent",
      }),
    ).rejects.toThrow(/MQTT/);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it("also publishes the consent-gated event to the bus, alongside the legacy topic", async () => {
    await executeHomeAssistantAction("user-1", email, rule, executedRule, {
      type: "mqtt",
      mqttTopic: "homeassistant/inbox/urgent",
    });

    expect(mockPublishUrgent).toHaveBeenCalledTimes(1);
    expect(mockPublishUrgent).toHaveBeenCalledWith({
      emailAccountId: "acct-1",
      ruleName: "Urgent",
      subject: "Invoice due",
      from: "billing@vendor.com",
    });
  });

  it("does not let a bus publish failure fail the rule action", async () => {
    mockPublishUrgent.mockRejectedValue(new Error("bus down"));

    await expect(
      executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "mqtt",
        mqttTopic: "homeassistant/inbox/urgent",
      }),
    ).resolves.toBeUndefined();

    // The legacy topic still got its publish; only the bus side failed.
    expect(mockPublish).toHaveBeenCalledTimes(1);
  });
});

describe("home assistant non-mqtt actions", () => {
  it("still throws the Home-Assistant-not-configured error when credentials are absent", async () => {
    mockFindUnique.mockResolvedValue({
      homeAssistantUrl: null,
      homeAssistantToken: null,
    });

    await expect(
      executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "persistent_notification",
      }),
    ).rejects.toThrow(/Home Assistant connection not configured/);
  });
});
