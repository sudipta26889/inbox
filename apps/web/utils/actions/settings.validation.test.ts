import { describe, expect, it, vi } from "vitest";
import {
  getDigestConfigBody,
  MQTT_SLUG_PATTERN,
  saveAiSettingsBody,
  saveDigestScheduleBody,
  updateDigestItemsBody,
  updateMqttSettingsBody,
} from "./settings.validation";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";

vi.mock("server-only", () => ({}));

describe("digest validation schemas", () => {
  it("getDigestConfigBody accepts empty object", () => {
    const result = getDigestConfigBody.safeParse({});
    expect(result.success).toBe(true);
  });

  it("saveDigestScheduleBody rejects all-null payload", () => {
    const result = saveDigestScheduleBody.safeParse({
      intervalDays: null,
      daysOfWeek: null,
      timeOfDay: null,
      occurrences: null,
    });
    expect(result.success).toBe(false);
  });

  it("saveDigestScheduleBody accepts intervalDays-only payload", () => {
    const result = saveDigestScheduleBody.safeParse({
      intervalDays: 1,
      daysOfWeek: null,
      timeOfDay: null,
      occurrences: 1,
    });
    expect(result.success).toBe(true);
  });

  it("updateDigestItemsBody accepts boolean map", () => {
    const result = updateDigestItemsBody.safeParse({
      ruleDigestPreferences: { r_1: true, r_2: false },
    });
    expect(result.success).toBe(true);
  });
});

describe("saveAiSettingsBody", () => {
  it("accepts default provider without api key", () => {
    const result = saveAiSettingsBody.safeParse({
      aiProvider: DEFAULT_PROVIDER,
      aiModel: "",
      aiApiKey: undefined,
    });

    expect(result.success).toBe(true);
  });

  it("requires api key for user-selectable providers", () => {
    const result = saveAiSettingsBody.safeParse({
      aiProvider: Provider.OPEN_AI,
      aiModel: "gpt-5.1",
      aiApiKey: undefined,
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(["aiApiKey"]);
    }
  });

  it("rejects vertex as a user-selectable provider", () => {
    const result = saveAiSettingsBody.safeParse({
      aiProvider: Provider.VERTEX,
      aiModel: "gemini-3-flash",
      aiApiKey: "unused-key",
    });

    expect(result.success).toBe(false);
  });
});

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
