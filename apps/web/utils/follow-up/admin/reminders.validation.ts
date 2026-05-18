import { z } from "zod";
import { ThreadTrackerType } from "@/generated/prisma/enums";

export const listFollowUpsInput = z.object({
  resolved: z.boolean().optional(),
  type: z.nativeEnum(ThreadTrackerType).optional(),
  appliedOnly: z.boolean().default(true),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});
export type ListFollowUpsInput = z.infer<typeof listFollowUpsInput>;

export const updateFollowUpInput = z
  .object({
    id: z.string(),
    resolved: z.boolean().optional(),
    followUpAppliedAt: z.coerce.date().nullable().optional(),
    followUpDraftId: z.string().nullable().optional(),
  })
  .refine(
    (v) =>
      v.resolved !== undefined ||
      v.followUpAppliedAt !== undefined ||
      v.followUpDraftId !== undefined,
    { message: "At least one mutable field must be provided" },
  );
export type UpdateFollowUpInput = z.infer<typeof updateFollowUpInput>;

export const deleteFollowUpInput = z.object({
  id: z.string(),
  expectedUpdatedAt: z.coerce.date().optional(),
  confirm: z.boolean().default(false),
});
export type DeleteFollowUpInput = z.infer<typeof deleteFollowUpInput>;
