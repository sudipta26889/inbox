import { z } from "zod";

export const emailsQuerySchema = z.object({
  account: z.string().min(1, "account is required"),
  query: z.string().min(1, "query is required"),
  limit: z.coerce.number().int().min(1).max(100).optional().default(25),
  cursor: z.string().optional(),
});

export const emailListItemSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  subject: z.string(),
  snippet: z.string(),
  labels: z.array(z.string()),
  received_at: z.string().datetime(),
});

export const emailsResponseSchema = z.object({
  emails: z.array(emailListItemSchema),
  next_cursor: z.string().nullable(),
});

export const emailPathParamsSchema = z.object({
  messageId: z.string().min(1),
});

export const emailDetailQuerySchema = z.object({
  account: z.string().min(1, "account is required"),
});

export const emailAttachmentSchema = z.object({
  id: z.string(),
  filename: z.string(),
  mime_type: z.string(),
  size_bytes: z.number().int().nonnegative(),
});

export const emailDetailResponseSchema = z.object({
  id: z.string(),
  thread_id: z.string(),
  from: z.string(),
  to: z.array(z.string()),
  subject: z.string(),
  snippet: z.string(),
  labels: z.array(z.string()),
  received_at: z.string().datetime(),
  body_html: z.string(),
  body_text: z.string(),
  attachments: z.array(emailAttachmentSchema),
});
