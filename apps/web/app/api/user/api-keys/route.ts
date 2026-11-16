import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";
import { getMcpServerAccess } from "@/utils/mcp/access";
import { listMcpConnections } from "@/utils/mcp/connections";

export type ApiKeyResponse = Awaited<ReturnType<typeof getApiKeys>>;

async function getApiKeys({
  userId,
  actorUserId,
  emailAccountId,
}: {
  userId: string;
  actorUserId: string;
  emailAccountId: string;
}) {
  // API keys belong to the mailbox owner; a shared user sees none of them.
  // MCP access and connections are per login, so they are always the actor's own.
  const isOwner = userId === actorUserId;
  const [apiKeys, mcpServerAccess] = await Promise.all([
    isOwner
      ? prisma.apiKey.findMany({
          where: { userId, emailAccountId, isActive: true },
          select: {
            id: true,
            name: true,
            createdAt: true,
            expiresAt: true,
            lastUsedAt: true,
            scopes: true,
          },
          orderBy: { createdAt: "desc" },
        })
      : [],
    getMcpServerAccess(actorUserId),
  ]);
  const mcpConnections = mcpServerAccess.enabled
    ? await listMcpConnections(actorUserId)
    : [];

  return {
    apiKeys,
    mcpServerAvailable: mcpServerAccess.available,
    mcpServerEnabled: mcpServerAccess.enabled,
    mcpConnections,
  };
}

export const GET = withEmailAccount("user/api-keys", async (request) => {
  const { userId, actorUserId, emailAccountId } = request.auth;

  const apiKeys = await getApiKeys({ userId, actorUserId, emailAccountId });

  return NextResponse.json(apiKeys);
});
