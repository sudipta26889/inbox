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
    apiKey: z.string().min(1).nullable().optional(),
    workspaceSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9-]+$/i)
      .nullable()
      .optional(),
    // Independent of the key and slug: the pin can change without the key.
    projectId: lowercaseUuid().nullable().optional(),
  })
  .superRefine((data, ctx) => {
    const keyTouched = data.apiKey !== undefined;
    const slugTouched = data.workspaceSlug !== undefined;

    if (!keyTouched && !slugTouched && data.projectId === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Nothing to update",
      });
      return;
    }

    // Key and slug stay coupled: both set, both cleared, or both left alone.
    if (keyTouched !== slugTouched) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Both apiKey and workspaceSlug must be set or cleared together",
      });
      return;
    }
    if (
      keyTouched &&
      (data.apiKey === null) !== (data.workspaceSlug === null)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Both apiKey and workspaceSlug must be set or cleared together",
      });
    }
  });

// TaskPilot ids are lowercase; a pasted upper-case UUID would never match.
function lowercaseUuid() {
  return z
    .string()
    .uuid()
    .transform((value) => value.toLowerCase());
}
