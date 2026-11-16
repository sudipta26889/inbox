import { z } from "zod";
import { DRAFT_DOCS_MAX_URLS } from "@/utils/config";

export const createKnowledgeBody = z.object({
  title: z.string().min(1, "Title is required"),
  content: z.string(),
});

export type CreateKnowledgeBody = z.infer<typeof createKnowledgeBody>;

export const updateKnowledgeBody = z.object({
  id: z.string(),
  title: z.string().min(1, "Title is required"),
  content: z.string(),
});

export type UpdateKnowledgeBody = z.infer<typeof updateKnowledgeBody>;

export const deleteKnowledgeBody = z.object({
  id: z.string(),
});

export type DeleteKnowledgeBody = z.infer<typeof deleteKnowledgeBody>;

export const updateDraftDocsUrlsBody = z.object({
  urls: z
    .array(z.string().trim().min(1))
    .max(
      DRAFT_DOCS_MAX_URLS,
      `You can add up to ${DRAFT_DOCS_MAX_URLS} documentation sites`,
    ),
});

export const listKnowledgeQuery = z.object({
  limit: z.number().int().positive().max(200).optional(),
  cursor: z.string().optional(),
});
export type ListKnowledgeQuery = z.infer<typeof listKnowledgeQuery>;

export const getKnowledgeBody = z.object({
  id: z.string().min(1),
});
export type GetKnowledgeBody = z.infer<typeof getKnowledgeBody>;

export const deleteKnowledgeConfirmBody = deleteKnowledgeBody.extend({
  confirm: z.boolean().default(false),
});
export type DeleteKnowledgeConfirmBody = z.infer<
  typeof deleteKnowledgeConfirmBody
>;
