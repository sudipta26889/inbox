import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("api/a2a-clients-tokens");

/**
 * A2A Client Token Management API
 *
 * View and revoke access tokens for a specific A2A client
 */

/**
 * GET /api/user/a2a-clients/[clientId]/tokens
 * List all active access tokens for this A2A client
 */
export const GET = withAuth(
  "user/a2a-clients/[clientId]/tokens",
  async (request, { params }) => {
    const userId = request.auth.userId;
    const { clientId } = params;

    // Verify client ownership
    const client = await prisma.mcpServerClient.findFirst({
      where: {
        clientId,
        userId,
        type: "A2A",
      },
    });

    if (!client) {
      return Response.json(
        { error: "Client not found or access denied" },
        { status: 404 },
      );
    }

    // Get all tokens for this client
    const tokens = await prisma.mcpServerAccessToken.findMany({
      where: {
        clientId,
        userId,
        revoked: false,
      },
      select: {
        id: true,
        scope: true,
        createdAt: true,
        expiresAt: true,
        lastUsedAt: true,
        emailAccount: {
          select: {
            email: true,
          },
        },
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return Response.json({
      clientId,
      tokens: tokens.map((token) => ({
        id: token.id,
        scope: token.scope,
        emailAccount: token.emailAccount?.email,
        createdAt: token.createdAt.toISOString(),
        expiresAt: token.expiresAt.toISOString(),
        lastUsedAt: token.lastUsedAt?.toISOString(),
        isExpired: token.expiresAt < new Date(),
      })),
    });
  },
);

export type GetA2aClientTokensResponse = Awaited<ReturnType<typeof GET.json>>;

/**
 * DELETE /api/user/a2a-clients/[clientId]/tokens
 * Revoke access tokens for this A2A client
 */
export const DELETE = withAuth(
  "user/a2a-clients/[clientId]/tokens",
  async (request, { params }) => {
    const userId = request.auth.userId;
    const { clientId } = params;
    const body = await request.json();

    const { tokenIds } = body as { tokenIds?: string[]; revokeAll?: boolean };

    // Verify client ownership
    const client = await prisma.mcpServerClient.findFirst({
      where: {
        clientId,
        userId,
        type: "A2A",
      },
    });

    if (!client) {
      return Response.json(
        { error: "Client not found or access denied" },
        { status: 404 },
      );
    }

    let revoked = 0;

    if (body.revokeAll) {
      // Revoke all tokens for this client
      const result = await prisma.mcpServerAccessToken.updateMany({
        where: {
          clientId,
          userId,
          revoked: false,
        },
        data: {
          revoked: true,
          revokedAt: new Date(),
        },
      });

      revoked = result.count;

      logger.info("Revoked all A2A client tokens", {
        userId,
        clientId,
        count: revoked,
      });
    } else if (tokenIds && tokenIds.length > 0) {
      // Revoke specific tokens
      const result = await prisma.mcpServerAccessToken.updateMany({
        where: {
          id: {
            in: tokenIds,
          },
          clientId,
          userId,
          revoked: false,
        },
        data: {
          revoked: true,
          revokedAt: new Date(),
        },
      });

      revoked = result.count;

      logger.info("Revoked specific A2A client tokens", {
        userId,
        clientId,
        tokenIds,
        count: revoked,
      });
    } else {
      return Response.json(
        {
          error: "Either tokenIds array or revokeAll=true must be provided",
        },
        { status: 400 },
      );
    }

    return Response.json({
      revoked,
    });
  },
);

export type RevokeA2aClientTokensResponse = Awaited<
  ReturnType<typeof DELETE.json>
>;
