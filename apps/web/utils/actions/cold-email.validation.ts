import { z } from "zod";

export const coldEmailBlockerBody = z.object({
  from: z.string(),
  subject: z.string(),
  textHtml: z.string().nullable(),
  textPlain: z.string().nullable(),
  snippet: z.string().nullable(),
  // Hacky fix. Not sure why this happens. Is internalDate sometimes a string and sometimes a number?
  date: z.string().or(z.number()).optional(),
  threadId: z.string().nullable(),
  messageId: z.string().nullable(),
});
export type ColdEmailBlockerBody = z.infer<typeof coldEmailBlockerBody>;

export const markNotColdEmailBody = z.object({ sender: z.string() });
export type MarkNotColdEmailBody = z.infer<typeof markNotColdEmailBody>;

// admin_cold_email_update_settings input
export const coldEmailUpdateSettingsBody = z.object({
  enabled: z.boolean().optional(),
  prompt: z.string().nullable().optional(),
  mode: z
    .enum([
      "DISABLED",
      "LIST",
      "LABEL",
      "ARCHIVE_AND_LABEL",
      "ARCHIVE_AND_READ_AND_LABEL",
    ])
    .optional(),
  labelName: z.string().min(1).optional(),
});
export type ColdEmailUpdateSettingsBody = z.infer<
  typeof coldEmailUpdateSettingsBody
>;

// admin_cold_email_list_blocked input
export const coldEmailListBlockedBody = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ColdEmailListBlockedBody = z.infer<typeof coldEmailListBlockedBody>;

// admin_cold_email_mark input
export const coldEmailMarkBody = z.object({
  sender: z.string().min(1),
  action: z.enum(["mark", "unmark"]),
  reason: z.string().nullable().optional(),
});
export type ColdEmailMarkBody = z.infer<typeof coldEmailMarkBody>;
