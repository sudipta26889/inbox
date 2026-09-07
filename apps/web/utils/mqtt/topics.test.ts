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
