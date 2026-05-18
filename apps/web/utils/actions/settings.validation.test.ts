import { describe, expect, it } from "vitest";
import {
  getDigestConfigBody,
  saveAiSettingsBody,
  saveDigestScheduleBody,
  updateDigestItemsBody,
} from "./settings.validation";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";

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
