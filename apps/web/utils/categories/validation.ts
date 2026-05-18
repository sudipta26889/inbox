import { z } from "zod";

export const createCategoryBody = z.object({
  id: z.string().nullish(),
  name: z.string().max(30),
  description: z.string().max(300).nullish(),
});
export type CreateCategoryBody = z.infer<typeof createCategoryBody>;

export const updateCategoryBody = z.object({
  categoryId: z.string(),
  name: z.string().max(30).optional(),
  description: z.string().max(300).nullish(),
});
export type UpdateCategoryBody = z.infer<typeof updateCategoryBody>;

export const deleteCategoryBody = z.object({
  categoryId: z.string(),
  confirm: z.boolean().default(false),
});
export type DeleteCategoryBody = z.infer<typeof deleteCategoryBody>;

export const listSendersBody = z.object({
  categoryId: z.string().nullish(),
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().nullish(),
});
export type ListSendersBody = z.infer<typeof listSendersBody>;

export const categorizeSendersBody = z.object({
  assignments: z
    .array(
      z.object({
        sender: z.string().min(1),
        categoryId: z.string(),
      }),
    )
    .min(1)
    .max(200),
});
export type CategorizeSendersBody = z.infer<typeof categorizeSendersBody>;
