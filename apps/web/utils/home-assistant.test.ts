import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import type { ExecutedRule } from "@/generated/prisma/client";

vi.mock("server-only", () => ({}));

const { mockPublish } = vi.hoisted(() => ({
  mockPublish: vi.fn().mockReturnValue(undefined),
}));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: () => true,
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
});

describe("home assistant mqtt action", () => {
  /**
   * These three topics have HA automations wired to them. The payload shape is
   * a published contract — only the transport is allowed to change.
   */
  it("publishes the same payload it used to send via the HA REST proxy", async () => {
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
});
