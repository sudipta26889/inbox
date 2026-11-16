import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import type { ExecutedRule } from "@/generated/prisma/client";
import { SafeError } from "@/utils/error";

vi.mock("server-only", () => ({}));

const {
  mockPublish,
  mockIsMqttConfigured,
  mockPublishUrgent,
  mockIsOwnerEmailAccount,
  mockNotifyOwner,
} = vi.hoisted(() => ({
  mockPublish: vi.fn().mockReturnValue(undefined),
  mockIsMqttConfigured: vi.fn().mockReturnValue(true),
  mockPublishUrgent: vi.fn().mockResolvedValue(undefined),
  mockIsOwnerEmailAccount: vi.fn().mockResolvedValue(false),
  mockNotifyOwner: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/mqtt/client", () => ({
  publishMqtt: mockPublish,
  isMqttConfigured: mockIsMqttConfigured,
}));
vi.mock("@/utils/mqtt/events", () => ({
  publishUrgent: mockPublishUrgent,
}));
vi.mock("@/utils/ntfy", () => ({
  isOwnerEmailAccount: mockIsOwnerEmailAccount,
  notifyOwner: mockNotifyOwner,
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    emailAccount: {
      findUnique: vi.fn(),
    },
  },
}));

import prisma from "@/utils/prisma";
import { executeHomeAssistantAction } from "./home-assistant";

const mockFindUnique = prisma.user.findUnique as Mock;
const mockEmailAccountFindUnique = prisma.emailAccount.findUnique as Mock;

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUnique.mockResolvedValue({
    homeAssistantUrl: "http://ha.local:8123",
    homeAssistantToken: "token-1",
  });
  // This account's own MQTT topic slug — used only by topics under inbox/.
  mockEmailAccountFindUnique.mockResolvedValue({
    mqttTopicSlug: "acct-1-slug",
  });
  mockIsMqttConfigured.mockReturnValue(true);
  mockPublishUrgent.mockResolvedValue(undefined);
  mockIsOwnerEmailAccount.mockResolvedValue(false);
  mockNotifyOwner.mockResolvedValue(undefined);
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

  describe("ntfy push to the owner's phone", () => {
    /**
     * The owner-check + notify chain is fire-and-forget (not awaited by
     * executeHomeAssistantAction — see the comment at its call site), so
     * awaiting the action alone does not guarantee it has settled yet. This
     * flushes the microtask queue: setImmediate runs only after every
     * pending microtask (including the chained awaits inside the
     * fire-and-forget promise) has drained, regardless of how many ticks it
     * took.
     */
    const flushMicrotasks = () =>
      new Promise((resolve) => setImmediate(resolve));

    it("pushes to ntfy when the account belongs to the owner", async () => {
      mockIsOwnerEmailAccount.mockResolvedValue(true);

      await executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "mqtt",
        mqttTopic: "homeassistant/inbox/urgent",
      });
      await flushMicrotasks();

      expect(mockIsOwnerEmailAccount).toHaveBeenCalledWith("acct-1");
      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Urgent",
          message: "Invoice due\nFrom: billing@vendor.com",
        }),
      );
    });

    /**
     * The ntfy topic is instance-wide. Without this gate, a second user's
     * urgent mail would push its subject line to the operator's phone.
     */
    it("does not push to ntfy for a non-owner account", async () => {
      mockIsOwnerEmailAccount.mockResolvedValue(false);

      await executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "mqtt",
        mqttTopic: "homeassistant/inbox/urgent",
      });
      await flushMicrotasks();

      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    /**
     * isOwnerEmailAccount does a database read; a blip there must not fail a
     * rule action that already delivered the MQTT message. Since the chain
     * is fire-and-forget, "not fail the rule action" no longer means the
     * outer promise waits on it at all — it means the rejection never
     * surfaces as an unhandled rejection either, which is what the .catch
     * at the call site is for.
     */
    it("does not let a failing owner check fail the rule action", async () => {
      mockIsOwnerEmailAccount.mockRejectedValue(new Error("db down"));

      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic: "homeassistant/inbox/urgent",
        }),
      ).resolves.toBeUndefined();
      await flushMicrotasks();

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockNotifyOwner).not.toHaveBeenCalled();
    });

    /**
     * Fix for the actual finding: notifyOwner has its own 5s fetch timeout,
     * and this whole path used to be awaited inline in executeMqttPublish,
     * serializing that latency into every matched email. Proving it no
     * longer blocks: executeHomeAssistantAction must resolve while
     * isOwnerEmailAccount's promise is still pending.
     */
    it("does not block the rule action on the owner check", async () => {
      let resolveOwnerCheck!: (value: boolean) => void;
      mockIsOwnerEmailAccount.mockReturnValue(
        new Promise((resolve) => {
          resolveOwnerCheck = resolve;
        }),
      );

      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic: "homeassistant/inbox/urgent",
        }),
      ).resolves.toBeUndefined();

      expect(mockNotifyOwner).not.toHaveBeenCalled();

      resolveOwnerCheck(true);
      await flushMicrotasks();

      expect(mockNotifyOwner).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * The three topics with HA automations already wired to them. Not under
   * inbox/ and don't end in "config", so the new topic guard must let them
   * all keep working exactly as before.
   */
  it.each([
    "homeassistant/inbox/urgent",
    "homeassistant/inbox/imp-notify",
    "homeassistant/inbox/remittance",
  ])("still allows the production topic %s", async (mqttTopic) => {
    await executeHomeAssistantAction("user-1", email, rule, executedRule, {
      type: "mqtt",
      mqttTopic,
    });

    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toBe(mqttTopic);
  });

  describe("cross-tenant topic guard", () => {
    /**
     * THE finding this guard exists for: any account holder can type a free-
     * text MQTT topic into a rule. Without this guard, account "acct-1" could
     * forge state into another tenant's `inbox/<their-slug>/...` namespace —
     * the same namespace the A2A bus documents as authoritative.
     */
    it("refuses a topic under another tenant's inbox/ namespace", async () => {
      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic: "inbox/some-other-tenant/urgent/state",
        }),
      ).rejects.toThrow(SafeError);

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("refuses every inbox/ topic when the account has no slug of its own", async () => {
      mockEmailAccountFindUnique.mockResolvedValue({ mqttTopicSlug: null });

      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic: "inbox/acct-1-slug/urgent/state",
        }),
      ).rejects.toThrow(SafeError);

      expect(mockPublish).not.toHaveBeenCalled();
    });

    it("allows an account to publish to its own inbox/<slug> namespace", async () => {
      await executeHomeAssistantAction("user-1", email, rule, executedRule, {
        type: "mqtt",
        mqttTopic: "inbox/acct-1-slug/urgent/state",
      });

      expect(mockPublish).toHaveBeenCalledTimes(1);
      expect(mockPublish.mock.calls[0][0]).toBe(
        "inbox/acct-1-slug/urgent/state",
      );
    });

    it.each([
      "+",
      "homeassistant/inbox/+",
      "inbox/#",
      "homeassistant/#",
    ])("refuses a topic containing an MQTT wildcard (%s)", async (mqttTopic) => {
      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic,
        }),
      ).rejects.toThrow(SafeError);

      expect(mockPublish).not.toHaveBeenCalled();
    });

    /**
     * A discovery config under homeassistant/ is how an entity gets defined
     * (or redefined/deleted) in Home Assistant — writing one lets a rule
     * hijack or delete another system's entity.
     */
    it("refuses writing a Home Assistant discovery config", async () => {
      await expect(
        executeHomeAssistantAction("user-1", email, rule, executedRule, {
          type: "mqtt",
          mqttTopic: "homeassistant/sensor/inbox_someone/urgent/config",
        }),
      ).rejects.toThrow(SafeError);

      expect(mockPublish).not.toHaveBeenCalled();
    });
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
