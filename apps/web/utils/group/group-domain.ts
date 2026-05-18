import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("group-domain");

export type GroupCtx = { userId: string; emailAccountId: string };

// Domain functions added in subsequent steps.
