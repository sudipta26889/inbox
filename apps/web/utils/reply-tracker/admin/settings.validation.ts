import { z } from "zod";
import { DraftReplyConfidence } from "@/generated/prisma/enums";

export const getReplyTrackerSettingsInput = z.object({});
export type GetReplyTrackerSettingsInput = z.infer<
  typeof getReplyTrackerSettingsInput
>;

export const updateReplyTrackerSettingsInput = z
  .object({
    draftRepliesEnabled: z.boolean().optional(),
    draftReplyConfidence: z.nativeEnum(DraftReplyConfidence).optional(),
    allowHiddenAiDraftLinks: z.boolean().optional(),
  })
  .refine(
    (v) =>
      v.draftRepliesEnabled !== undefined ||
      v.draftReplyConfidence !== undefined ||
      v.allowHiddenAiDraftLinks !== undefined,
    { message: "At least one field must be provided" },
  );
export type UpdateReplyTrackerSettingsInput = z.infer<
  typeof updateReplyTrackerSettingsInput
>;
