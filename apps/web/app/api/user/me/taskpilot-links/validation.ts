import { z } from "zod";

// Clients chunk at this size; a bigger request is refused, never truncated.
export const TASKPILOT_LINKS_MAX_THREADS = 100;

export const taskpilotLinksBody = z.object({
  threads: z
    .array(
      z.object({
        threadId: z.string().min(1),
        messageIds: z.array(z.string().min(1)).max(500),
      }),
    )
    .min(1)
    .max(TASKPILOT_LINKS_MAX_THREADS),
});
export type TaskpilotLinksBody = z.infer<typeof taskpilotLinksBody>;
