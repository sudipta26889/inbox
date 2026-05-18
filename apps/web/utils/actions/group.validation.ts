import { z } from "zod";
import { GroupItemType } from "@/generated/prisma/enums";

export const createGroupBody = z.object({
  ruleId: z.string().min(1, "Rule ID is required"),
});
export type CreateGroupBody = z.infer<typeof createGroupBody>;

export const getGroupBody = z.object({
  groupId: z.string().min(1),
});
export type GetGroupBody = z.infer<typeof getGroupBody>;

export const updateGroupBody = z.object({
  groupId: z.string().min(1),
  name: z.string().min(1).max(120).optional(),
  prompt: z.string().max(2000).nullable().optional(),
});
export type UpdateGroupBody = z.infer<typeof updateGroupBody>;

export const deleteGroupBody = z.object({
  groupId: z.string().min(1),
  confirm: z.boolean().default(false),
});
export type DeleteGroupBody = z.infer<typeof deleteGroupBody>;

export const addGroupItemBody = z.object({
  groupId: z.string(),
  type: z.enum([GroupItemType.FROM, GroupItemType.SUBJECT]),
  value: z.string().min(1),
  exclude: z.boolean().optional(),
});
export type AddGroupItemBody = z.infer<typeof addGroupItemBody>;

export const removeGroupItemBody = z.object({
  itemId: z.string().min(1),
});
export type RemoveGroupItemBody = z.infer<typeof removeGroupItemBody>;
