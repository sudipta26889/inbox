import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type McpClientsResponse = Awaited<ReturnType<typeof getMcpClients>>;

export const GET = withAuth("user/mcp-clients", async (request) => {
  const result = await getMcpClients(request.auth.userId);
  return Response.json(result);
});

// Revoke, never delete: client rows are shared between users (a metadata-URL
// client has one row for everyone), and deleting one cascades to every
// user's tokens.
export const DELETE = withAuth("user/mcp-clients", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();
  const { clientIds } = body as { clientIds: string[] };

  if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
    return Response.json({ error: "clientIds is required" }, { status: 400 });
  }

  const result = await prisma.mcpServerAccessToken.updateMany({
    where: {
      userId,
      clientId: { in: clientIds },
      client: { type: "MCP" },
      revoked: false,
    },
    data: { revoked: true, revokedAt: new Date(), revokedReason: "user" },
  });

  return Response.json({ revoked: result.count });
});

async function getMcpClients(userId: string) {
  const clients = await prisma.mcpServerClient.findMany({
    where: {
      type: "MCP",
      accessTokens: { some: { userId, revoked: false } },
    },
    select: {
      clientId: true,
      clientName: true,
      logoUri: true,
      redirectUris: true,
      accessTokens: {
        where: { userId },
        select: { lastUsedAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return {
    mcpClients: clients.map((client) => ({
      clientId: client.clientId,
      clientName: client.clientName,
      logoUri: client.logoUri,
      host: clientHost(client.clientId, client.redirectUris),
      lastUsedAt: latest(client.accessTokens.map((t) => t.lastUsedAt)),
    })),
  };
}

// For a metadata-URL client the clientId host is what the user can verify;
// otherwise the first redirect URI is the best identity there is.
function clientHost(clientId: string, redirectUris: string[]): string {
  const source = clientId.startsWith("https://") ? clientId : redirectUris[0];
  try {
    return new URL(source).host;
  } catch {
    return "";
  }
}

function latest(dates: (Date | null)[]): Date | null {
  let max: Date | null = null;
  for (const date of dates) {
    if (date && (!max || date > max)) max = date;
  }
  return max;
}
