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
