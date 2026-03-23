import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { generateSecureToken } from "@/utils/mcp-server/pkce";
import { z } from "zod";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("api/a2a-clients");

/**
 * A2A Client Management API
 *
 * Allows users to create and manage OAuth clients for A2A protocol agents.
 * Users can create clients, view them, and revoke access.
 */

/**
 * Schema for creating a new A2A client
 */
const createClientSchema = z.object({
  clientName: z
    .string()
    .min(1, "Client name is required")
    .max(100, "Client name too long"),
  description: z.string().max(500, "Description too long").optional(),
  redirectUris: z
    .array(z.string().url("Invalid redirect URI"))
    .min(1, "At least one redirect URI is required")
    .max(10, "Maximum 10 redirect URIs allowed"),
  logoUri: z.string().url("Invalid logo URI").optional(),
});

/**
 * Schema for updating an A2A client
 */
const updateClientSchema = z.object({
  clientId: z.string(),
  clientName: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  redirectUris: z.array(z.string().url()).min(1).max(10).optional(),
  logoUri: z.string().url().optional(),
});

/**
 * GET /api/user/a2a-clients
 * List all A2A clients owned by the current user
 */
export const GET = withAuth("user/a2a-clients", async (request) => {
  const userId = request.auth.userId;

  const clients = await prisma.mcpServerClient.findMany({
    where: {
      userId,
      type: "A2A",
    },
    select: {
      id: true,
      clientId: true,
      clientName: true,
      description: true,
      redirectUris: true,
      logoUri: true,
      type: true,
      createdAt: true,
      updatedAt: true,
      lastUsedAt: true,
      _count: {
        select: {
          accessTokens: {
            where: {
              revoked: false,
            },
          },
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
  });

  return Response.json({
    clients: clients.map((client) => ({
      ...client,
      activeTokenCount: client._count.accessTokens,
      _count: undefined, // Remove internal count field
    })),
  });
});

export type GetA2aClientsResponse =
  Awaited<ReturnType<typeof GET>> extends Response
    ? Awaited<ReturnType<typeof GET.json>>
    : never;

/**
 * POST /api/user/a2a-clients
 * Create a new A2A OAuth client
 */
export const POST = withAuth("user/a2a-clients", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();

  // Validate input
  const validation = createClientSchema.safeParse(body);
  if (!validation.success) {
    return Response.json(
      {
        error: "Validation failed",
        details: validation.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { clientName, description, redirectUris, logoUri } = validation.data;

  // Check client limit (max 10 clients per user to prevent abuse)
  const existingClientCount = await prisma.mcpServerClient.count({
    where: {
      userId,
      type: "A2A",
    },
  });

  if (existingClientCount >= 10) {
    return Response.json(
      {
        error: "Client limit reached",
        message: "You can create a maximum of 10 A2A clients",
      },
      { status: 400 },
    );
  }

  // Generate client credentials
  const clientId = `a2a_${generateSecureToken()}`;
  const clientSecret = generateSecureToken();

  // Create client
  const client = await prisma.mcpServerClient.create({
    data: {
      clientId,
      clientSecret,
      clientName,
      description,
      redirectUris,
      logoUri,
      type: "A2A",
      userId,
    },
    select: {
      id: true,
      clientId: true,
      clientSecret: true,
      clientName: true,
      description: true,
      redirectUris: true,
      logoUri: true,
      type: true,
      createdAt: true,
    },
  });

  logger.info("Created A2A client", {
    userId,
    clientId: client.clientId,
    clientName,
  });

  return Response.json({
    client,
    warning:
      "IMPORTANT: Save the client_secret now. You won't be able to see it again.",
  });
});

export type CreateA2aClientResponse = Awaited<ReturnType<typeof POST.json>>;

/**
 * PATCH /api/user/a2a-clients
 * Update an existing A2A client
 */
export const PATCH = withAuth("user/a2a-clients", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();

  // Validate input
  const validation = updateClientSchema.safeParse(body);
  if (!validation.success) {
    return Response.json(
      {
        error: "Validation failed",
        details: validation.error.flatten().fieldErrors,
      },
      { status: 400 },
    );
  }

  const { clientId, ...updates } = validation.data;

  // Verify ownership
  const existingClient = await prisma.mcpServerClient.findFirst({
    where: {
      clientId,
      userId,
      type: "A2A",
    },
  });

  if (!existingClient) {
    return Response.json(
      {
        error: "Client not found or access denied",
      },
      { status: 404 },
    );
  }

  // Update client
  const client = await prisma.mcpServerClient.update({
    where: {
      id: existingClient.id,
    },
    data: updates,
    select: {
      id: true,
      clientId: true,
      clientName: true,
      description: true,
      redirectUris: true,
      logoUri: true,
      type: true,
      updatedAt: true,
    },
  });

  logger.info("Updated A2A client", {
    userId,
    clientId,
  });

  return Response.json({ client });
});

export type UpdateA2aClientResponse = Awaited<ReturnType<typeof PATCH.json>>;

/**
 * DELETE /api/user/a2a-clients
 * Delete A2A clients and revoke all their access tokens
 */
export const DELETE = withAuth("user/a2a-clients", async (request) => {
  const userId = request.auth.userId;
  const body = await request.json();

  const { clientIds } = body as { clientIds: string[] };

  if (!clientIds || !Array.isArray(clientIds) || clientIds.length === 0) {
    return Response.json(
      { error: "clientIds array is required" },
      { status: 400 },
    );
  }

  // Delete clients and all associated data
  // This will cascade delete access tokens, auth codes, etc.
  const deleted = await prisma.mcpServerClient.deleteMany({
    where: {
      clientId: {
        in: clientIds,
      },
      userId,
      type: "A2A",
    },
  });

  logger.info("Deleted A2A clients", {
    userId,
    count: deleted.count,
    clientIds,
  });

  return Response.json({
    deleted: deleted.count,
  });
});

export type DeleteA2aClientsResponse = Awaited<ReturnType<typeof DELETE.json>>;
