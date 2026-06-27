import { z } from "zod";

export const enrichedTaskDraftSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
  description_html: z.string().min(1),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  labelNames: z.array(z.string()).default([]),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const convertEmailDraftBody = z.object({
  messageId: z.string().min(1),
});

export const commitTaskpilotTaskBody = z.object({
  messageId: z.string().min(1),
  draft: enrichedTaskDraftSchema,
});

export const updateTaskpilotIntegrationBody = z
  .object({
    apiKey: z.string().min(1).nullable(),
    workspaceSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/i)
      .nullable(),
  })
  .superRefine((data, ctx) => {
    const bothNull = data.apiKey === null && data.workspaceSlug === null;
    const bothSet = data.apiKey !== null && data.workspaceSlug !== null;
    if (!bothNull && !bothSet) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Both apiKey and workspaceSlug must be set or cleared together",
      });
    }
  });
