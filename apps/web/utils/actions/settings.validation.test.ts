import { describe, expect, it, vi } from "vitest";
import {
  MQTT_SLUG_PATTERN,
  updateMqttSettingsBody,
} from "./settings.validation";

vi.mock("server-only", () => ({}));

describe("updateMqttSettingsBody", () => {
  const valid = {
    mqttEnabled: true,
    mqttTopicSlug: "work",
    mqttIncludeDetail: false,
  };

  it("accepts a valid slug", () => {
    const result = updateMqttSettingsBody.safeParse(valid);
    expect(result.success).toBe(true);
  });

  it("accepts disabling with no slug set", () => {
    const result = updateMqttSettingsBody.safeParse({
      ...valid,
      mqttEnabled: false,
      mqttTopicSlug: "",
    });
    expect(result.success).toBe(true);
  });

  it("refuses enabling with no slug set", () => {
    const result = updateMqttSettingsBody.safeParse({
      ...valid,
      mqttEnabled: true,
      mqttTopicSlug: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["mqttTopicSlug"]);
    }
  });

  it.each([
    ["a slash, which would reroute the topic namespace", "work/personal"],
    ["a leading dash", "-work"],
    ["an uppercase letter", "Work"],
    ["a wildcard", "work#"],
    ["a plus wildcard", "work+"],
    ["32 characters, one past the limit", "a".repeat(32)],
    ["a space", "my work"],
  ])("rejects a slug with %s", (_label, slug) => {
    const result = updateMqttSettingsBody.safeParse({
      ...valid,
      mqttTopicSlug: slug,
    });
    expect(result.success).toBe(false);
  });

  it("accepts the maximum-length slug (31 characters)", () => {
    const result = updateMqttSettingsBody.safeParse({
      ...valid,
      mqttTopicSlug: "a".repeat(31),
    });
    expect(result.success).toBe(true);
  });

  /**
   * The pattern is duplicated on purpose: topics.ts is server-only, and this
   * schema also runs in the browser via zodResolver. Nothing else keeps the two
   * copies equal, and a divergence is silent — the form would accept a slug the
   * publisher later refuses, or worse, one that corrupts a topic string and
   * routes one account's events into another's namespace.
   */
  it("keeps the client-side slug pattern identical to the publisher's", async () => {
    const { SLUG_PATTERN } = await import("@/utils/mqtt/topics");

    expect(MQTT_SLUG_PATTERN.source).toBe(SLUG_PATTERN.source);
    expect(MQTT_SLUG_PATTERN.flags).toBe(SLUG_PATTERN.flags);
  });
});
