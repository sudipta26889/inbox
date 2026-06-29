import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("action-create-task");

/**
 * CREATE_TASK action: a canCreate signal only. The actual TaskPilot decision
 * happens in the post-rules hook (maybeRouteToTaskPilot), which inspects
 * executedRules to find this action type. The hook may pick COMMENT_ON over
 * CREATE when a strong similar task exists (B+C policy).
 *
 * ponytail: stub — real logic lives in route.ts maybeRouteToTaskPilot (Task 17)
 */
export async function executeCreateTaskAction(input: {
  messageId: string;
  emailAccountId: string;
}): Promise<void> {
  logger.info("CREATE_TASK signal emitted; post-rules hook will decide", {
    messageId: input.messageId,
    emailAccountId: input.emailAccountId,
  });
}
