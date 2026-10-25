import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import type { McpToolContext } from "@/utils/mcp-server/tools/registry";

/**
 * Build the context MCP tools run with. Account-scoped tools use `userId`, which
 * is the bound account's owner (so shared accounts pass `{ id, userId }` checks);
 * multi-account tools use `callerUserId` to list what the caller can reach.
 * Returns null when the caller no longer has access to the bound account.
 */
export async function buildMcpToolContext({
  userId,
  emailAccountId,
  clientId,
  scopes,
}: {
  userId: string;
  emailAccountId: string;
  clientId: string;
  scopes: string[];
}): Promise<McpToolContext | null> {
  if (!emailAccountId) {
    return { userId, callerUserId: userId, emailAccountId, clientId, scopes };
  }

  const emailAccount = await prisma.emailAccount.findFirst({
    where: { id: emailAccountId, ...accessibleEmailAccountWhere(userId) },
    select: { userId: true },
  });
  if (!emailAccount) return null;

  return {
    userId: emailAccount.userId,
    callerUserId: userId,
    emailAccountId,
    clientId,
    scopes,
  };
}

export function getCallerUserId(context: McpToolContext) {
  return context.callerUserId ?? context.userId;
}
