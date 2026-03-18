import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export const GET = withAuth("user/mcp-clients", async (request) => {
  const userId = request.auth.userId;
  const mcpClients = await prisma.mcpServerClient.findMany({
    where: {
      accessTokens: {
        some: {
          userId,
        },
      },
    },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      logoUri: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          accessTokens: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return Response.json({ mcpClients });
});

export const DELETE = withAuth("user/mcp-clients", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();
  const { clientIds } = body as { clientIds: string[] };

  if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
    return Response.json({ error: "clientIds is required" }, { status: 400 });
  }

  // Delete MCP clients - this will cascade delete access tokens and auth codes
  const deleted = await prisma.mcpServerClient.deleteMany({
    where: {
      clientId: {
        in: clientIds,
      },
      accessTokens: {
        some: {
          userId,
        },
      },
    },
  });

  return Response.json({ deleted: deleted.count });
});
