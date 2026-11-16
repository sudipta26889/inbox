import { z } from "zod";

export const accountSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  provider: z.string(),
  is_default: z.boolean(),
});

export const accountsResponseSchema = z.object({
  accounts: z.array(accountSchema),
});
