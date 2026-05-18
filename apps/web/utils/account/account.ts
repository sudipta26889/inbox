import { createScopedLogger } from "@/utils/logger";
import { NotFoundError } from "@/utils/mcp-server/errors";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("account-domain");

/**
 * Fields exposed by the admin_account_* MCP tools.
 *
 * The select clause is the primary defense for the security guarantee in
 * Plan 09: credential / auth / billing / AI-model / subsystem-owned fields
 * are NEVER requested from Prisma, so they cannot leak into the response.
 */
const profileSelect = {
  id: true,
  email: true,
  createdAt: true,
  updatedAt: true,
  image: true,
  name: true,
  about: true,
  signature: true,
  timezone: true,
  calendarBookingLink: true,
  role: true,
} as const;

export type AccountProfile = Awaited<ReturnType<typeof getAccountProfile>>;

export async function getAccountProfile(ctx: {
  userId: string;
  emailAccountId: string;
}) {
  const row = await prisma.emailAccount.findFirst({
    where: { id: ctx.emailAccountId, userId: ctx.userId },
    select: profileSelect,
  });
  if (!row) {
    logger.warn("getAccountProfile: account not found", {
      emailAccountId: ctx.emailAccountId,
    });
    throw new NotFoundError("Email account not found");
  }
  return row;
}
