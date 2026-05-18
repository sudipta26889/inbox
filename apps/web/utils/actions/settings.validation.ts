import { z } from "zod";
import { Frequency } from "@/generated/prisma/enums";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";

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

export const getDigestConfigBody = z.object({}).strict();
export type GetDigestConfigBody = z.infer<typeof getDigestConfigBody>;

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
    aiProvider: z.enum([
      DEFAULT_PROVIDER,
      Provider.ANTHROPIC,
      Provider.OPEN_AI,
      Provider.AZURE,
      Provider.GOOGLE,
      Provider.GROQ,
      Provider.OPENROUTER,
      Provider.AI_GATEWAY,
      Provider.LITELLM,
    ]),
    aiModel: z.string(),
    aiApiKey: z.string().optional(),
  })
  .superRefine((val, ctx) => {
    if (
      !val.aiApiKey &&
      val.aiProvider !== DEFAULT_PROVIDER &&
      val.aiProvider !== Provider.LITELLM
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "You must provide an API key for this provider",
        path: ["aiApiKey"],
      });
    }
  });
export type SaveAiSettingsBody = z.infer<typeof saveAiSettingsBody>;

export const updateDigestItemsBody = z.object({
  ruleDigestPreferences: z.record(z.string(), z.boolean()),
});
export type UpdateDigestItemsBody = z.infer<typeof updateDigestItemsBody>;

export const toggleDigestBody = z.object({
  enabled: z.boolean(),
  timeOfDay: z.coerce.date().optional(),
});
export type ToggleDigestBody = z.infer<typeof toggleDigestBody>;
