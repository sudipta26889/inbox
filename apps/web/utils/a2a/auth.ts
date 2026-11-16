import {
  validateAccessToken,
  type McpTokenPayload,
} from "@/utils/mcp-server/tokens";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("a2a-auth");

/**
 * A2A Authentication Result
 */
export interface A2aAuthContext {
  clientId: string;
  emailAccountId: string;
  scopes: string[];
  tokenPayload: McpTokenPayload;
  userId: string;
}

/**
 * Authenticate an A2A request using Bearer token
 *
 * Validates the OAuth 2.0 Bearer token and returns authentication context.
 * Reuses existing MCP OAuth infrastructure.
 *
 * @param authHeader - The Authorization header value
 * @returns Authentication context or null if invalid
 */
export async function authenticateA2aRequest(
  authHeader: string | null,
): Promise<A2aAuthContext | null> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Missing or invalid Authorization header");
    return null;
  }

  const token = authHeader.substring(7);
  const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";

  // Validate token using existing MCP infrastructure
  const tokenPayload = await validateAccessToken(token, jwtSecret);

  if (!tokenPayload) {
    logger.warn("Invalid or expired access token");
    return null;
  }

  // Verify the client exists and is an A2A client
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId: tokenPayload.client_id },
  });

  if (!client) {
    logger.warn("Client not found", { clientId: tokenPayload.client_id });
    return null;
  }

  // Update client last used timestamp
  await prisma.mcpServerClient.update({
    where: { id: client.id },
    data: { lastUsedAt: new Date() },
  });

  const scopes = tokenPayload.scope ? tokenPayload.scope.split(" ") : [];

  logger.info("Authenticated A2A request", {
    userId: tokenPayload.sub,
    clientId: tokenPayload.client_id,
    clientType: client.type,
    scopes,
  });

  return {
    userId: tokenPayload.sub,
    emailAccountId: tokenPayload.email_account_id,
    clientId: tokenPayload.client_id,
    scopes,
    tokenPayload,
  };
}

/**
 * Check if the authenticated context has the required scope
 *
 * @param context - Authentication context from authenticateA2aRequest
 * @param requiredScope - The scope required for the operation
 * @returns true if the context has the required scope
 */
export function hasRequiredScope(
  context: A2aAuthContext,
  requiredScope: string,
): boolean {
  return context.scopes.includes(requiredScope);
}

/**
 * Check if the authenticated context has ANY of the required scopes
 *
 * @param context - Authentication context
 * @param requiredScopes - Array of scopes (user needs at least one)
 * @returns true if the context has at least one of the required scopes
 */
export function hasAnyScope(
  context: A2aAuthContext,
  requiredScopes: string[],
): boolean {
  return requiredScopes.some((scope) => context.scopes.includes(scope));
}

/**
 * Check if the authenticated context has ALL of the required scopes
 *
 * @param context - Authentication context
 * @param requiredScopes - Array of scopes (user needs all of them)
 * @returns true if the context has all required scopes
 */
export function hasAllScopes(
  context: A2aAuthContext,
  requiredScopes: string[],
): boolean {
  return requiredScopes.every((scope) => context.scopes.includes(scope));
}

/**
 * Verify that a user owns a specific email account
 *
 * @param userId - User ID from authentication context
 * @param emailAccountId - Email account ID to verify
 * @returns true if the user owns the email account
 */
export async function verifyEmailAccountOwnership(
  userId: string,
  emailAccountId: string,
): Promise<boolean> {
  const emailAccount = await prisma.emailAccount.findFirst({
    where: {
      id: emailAccountId,
      userId,
    },
  });

  return !!emailAccount;
}

/**
 * Get all email accounts for a user
 * Used for multi-account operations
 *
 * @param userId - User ID from authentication context
 * @returns Array of email account IDs
 */
export async function getUserEmailAccounts(userId: string): Promise<string[]> {
  const accounts = await prisma.emailAccount.findMany({
    where: { userId },
    select: { id: true },
  });

  return accounts.map((account) => account.id);
}

/**
 * Create an unauthorized error response
 * Following OAuth 2.0 error response format (RFC 6750)
 */
export function createUnauthorizedResponse(
  error = "invalid_token",
  errorDescription = "Invalid or expired access token",
) {
  return {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer resource_metadata="${env.NEXT_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", error="${error}", error_description="${errorDescription}"`,
    },
    body: {
      detail: errorDescription,
      error,
      error_description: errorDescription,
    },
  };
}

/**
 * Create a forbidden error response
 * Used when authentication succeeds but authorization fails
 */
export function createForbiddenResponse(
  requiredScope: string,
  message?: string,
) {
  return {
    status: 403,
    body: {
      detail:
        message || `Insufficient permissions. Required scope: ${requiredScope}`,
      error: "insufficient_scope",
      required_scope: requiredScope,
    },
  };
}

/**
 * Validate that the client is authorized to access this skill
 * Checks both OAuth scope and client type
 *
 * @param context - Authentication context
 * @param skillName - The A2A skill being accessed
 * @param skillScope - The OAuth scope required for this skill
 * @returns Error response object or null if authorized
 */
export async function validateSkillAccess(
  context: A2aAuthContext,
  skillName: string,
  skillScope: string,
): Promise<ReturnType<typeof createForbiddenResponse> | null> {
  // Check if the client has the required scope
  if (!hasRequiredScope(context, skillScope)) {
    logger.warn("Insufficient scope for skill", {
      clientId: context.clientId,
      skill: skillName,
      requiredScope: skillScope,
      actualScopes: context.scopes,
    });

    return createForbiddenResponse(
      skillScope,
      `Skill '${skillName}' requires scope '${skillScope}'`,
    );
  }

  return null;
}

/**
 * Middleware-style auth wrapper for A2A endpoints
 * Authenticates request and validates required scopes
 *
 * @param request - Next.js Request object
 * @param requiredScopes - Array of required OAuth scopes
 * @returns Authentication context or throws error response
 */
export async function withA2aAuth(
  request: Request,
  requiredScopes: string[],
): Promise<A2aAuthContext> {
  const authHeader = request.headers.get("Authorization");
  const context = await authenticateA2aRequest(authHeader);

  if (!context) {
    const unauthorized = createUnauthorizedResponse();
    throw new Response(JSON.stringify(unauthorized.body), {
      status: unauthorized.status,
      headers: unauthorized.headers,
    });
  }

  // An empty list means "authentication only" — note hasAnyScope([]) is false,
  // so without this an empty list would forbid every request instead.
  if (requiredScopes.length > 0 && !hasAnyScope(context, requiredScopes)) {
    const forbidden = createForbiddenResponse(
      requiredScopes.join(", "),
      `One of these scopes is required: ${requiredScopes.join(", ")}`,
    );
    throw new Response(JSON.stringify(forbidden.body), {
      status: forbidden.status,
    });
  }

  return context;
}
