import { z } from "zod";
import { Frequency } from "@/generated/prisma/enums";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";
import { SENSITIVE_DATA_POLICIES } from "@/utils/dlp/sensitive-content";

export const saveDigestScheduleBody = z
  .object({
    intervalDays: z.number().int().positive().nullable(),
    daysOfWeek: z.number().int().min(0).max(127).nullable(),
    timeOfDay: z.coerce.date().nullable(),
    occurrences: z.number().int().positive().nullable(),
  })
  .refine(
    (v) =>
      v.intervalDays !== null ||
      v.daysOfWeek !== null ||
      v.timeOfDay !== null ||
      v.occurrences !== null,
    { message: "At least one schedule field must be provided" },
  );
export type SaveDigestScheduleBody = z.infer<typeof saveDigestScheduleBody>;

export const saveEmailUpdateSettingsBody = z.object({
  statsEmailFrequency: z.enum([Frequency.WEEKLY, Frequency.NEVER]),
  summaryEmailFrequency: z.enum([Frequency.WEEKLY, Frequency.NEVER]),
  digestEmailFrequency: z.enum([
    Frequency.DAILY,
    Frequency.WEEKLY,
    Frequency.NEVER,
  ]),
});
export type SaveEmailUpdateSettingsBody = z.infer<
  typeof saveEmailUpdateSettingsBody
>;

export const saveAiSettingsBody = z
  .object({
    // Mail is personal data: a saved model may only be the deployment default
    // or the local models behind LiteLLM, never a cloud provider.
    aiProvider: z.enum([DEFAULT_PROVIDER, Provider.LITELLM]),
    aiModel: z.string(),
    aiApiKey: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    // An empty model saved with a provider fails every request later, so
    // reject it on save.
    if (val.aiProvider !== DEFAULT_PROVIDER && !val.aiModel.trim()) {
      ctx.addIssue({
        code: "custom",
        message: "You must pick a model for this provider",
        path: ["aiModel"],
      });
    }
  });
export type SaveAiSettingsBody = z.infer<typeof saveAiSettingsBody>;

export const saveDecisionModelSettingsBody = z.object({
  decisionModelEnabled: z.boolean(),
});

export const saveSensitiveDataPolicyBody = z.object({
  sensitiveDataPolicy: z.enum(SENSITIVE_DATA_POLICIES),
});
export type SaveSensitiveDataPolicyBody = z.infer<
  typeof saveSensitiveDataPolicyBody
>;

export const updateDigestItemsBody = z.object({
  ruleDigestPreferences: z.record(z.string(), z.boolean()),
});
export type UpdateDigestItemsBody = z.infer<typeof updateDigestItemsBody>;

export const toggleDigestBody = z.object({
  enabled: z.boolean(),
  timeOfDay: z.coerce.date().optional(),
});
export type ToggleDigestBody = z.infer<typeof toggleDigestBody>;

// Mirrors the SLUG_PATTERN in utils/mqtt/topics.ts exactly. Duplicated rather
// than imported: that module is server-only, but this schema also runs
// client-side via zodResolver. The slug is substituted into an MQTT topic
// string and an HA unique_id, so a mismatch here could let a slash or
// wildcard through to the server unvalidated.
export const MQTT_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,30}$/;

export const updateMqttSettingsBody = z
  .object({
    mqttEnabled: z.boolean(),
    mqttTopicSlug: z
      .string()
      .trim()
      .refine((slug) => slug === "" || MQTT_SLUG_PATTERN.test(slug), {
        message:
          "Use lowercase letters, numbers, - or _ only, starting with a letter or number (max 31 characters)",
      }),
    mqttIncludeDetail: z.boolean(),
  })
  .refine((v) => !v.mqttEnabled || v.mqttTopicSlug !== "", {
    message: "Set a topic name before enabling the bus",
    path: ["mqttTopicSlug"],
  });
export type UpdateMqttSettingsBody = z.infer<typeof updateMqttSettingsBody>;
export const getDigestConfigBody = z.object({}).strict();
export type GetDigestConfigBody = z.infer<typeof getDigestConfigBody>;

export const setDigestEnabledBody = z.object({ enabled: z.boolean() }).strict();
export type SetDigestEnabledBody = z.infer<typeof setDigestEnabledBody>;
