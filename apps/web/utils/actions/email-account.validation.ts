import { z } from "zod";

export const updateReferralSignatureBody = z.object({
  enabled: z.boolean(),
});

export const updateHiddenAiDraftLinksBody = z.object({
  enabled: z.boolean(),
});

export const shareEmailAccountBody = z.object({
  email: z.string().trim().toLowerCase().email(),
});

export const unshareEmailAccountBody = z.object({
  userId: z.string(),
});
