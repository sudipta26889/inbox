import { z } from "zod";

export const StateGroupEnum = z.enum([
  "backlog",
  "unstarted",
  "started",
  "completed",
  "cancelled",
  "triage",
]);

export const PriorityEnum = z.enum(["urgent", "high", "medium", "low", "none"]);

export const Pass1Schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("IGNORE"),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("COMMENT_ON"),
    targetIssueIds: z.array(z.string()).min(1).max(3),
    comment: z.object({
      summary: z.string(),
      highlights: z.array(z.string()).max(5).default([]),
    }),
    stateGroup: StateGroupEnum.nullable(),
    stateConfidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
    fieldUpdatesNeeded: z.boolean(),
    reason: z.string(),
  }),
  z.object({
    action: z.literal("CREATE"),
    draft: z.object({
      projectId: z.string(),
      title: z.string().max(140),
      descriptionHtml: z.string(),
      priority: PriorityEnum,
      labelNames: z.array(z.string()),
      targetDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .nullable(),
    }),
    reason: z.string(),
  }),
]);

export const Pass2Schema = z.object({
  updates: z
    .array(
      z.object({
        targetIssueId: z.string(),
        priority: PriorityEnum.nullable(),
        targetDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable(),
        addLabelNames: z.array(z.string()),
        removeLabelNames: z.array(z.string()),
        assigneeEmail: z.string().nullable(),
      }),
    )
    .max(3),
  reason: z.string(),
});

export type Pass1Decision = z.infer<typeof Pass1Schema>;
export type Pass2Updates = z.infer<typeof Pass2Schema>;
export type StateGroup = z.infer<typeof StateGroupEnum>;
export type Priority = z.infer<typeof PriorityEnum>;
