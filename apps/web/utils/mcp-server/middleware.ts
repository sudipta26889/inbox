import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  validateAccessToken,
  type McpTokenPayload,
  type McpScope,
  hasScope,
} from "./tokens";
import { SafeError } from "@/utils/error";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("mcp-auth-middleware");

/**
 * Extended NextRequest with MCP auth context
 */
export interface McpAuthenticatedRequest extends NextRequest {
  mcpAuth: {
    token: McpTokenPayload;
    userId: string;
    emailAccountId: string;
    clientId: string;
    scopes: string[];
  };
  logger: ReturnType<typeof createScopedLogger>;
}

/**
 * MCP Authentication Middleware
 *
 * Validates Bearer token from Authorization header and attaches
 * authentication context to the request.
 *
 * Usage:
 * ```ts
 * export const GET = withMcpAuth(async (request: McpAuthenticatedRequest) => {
 *   const { userId, emailAccountId } = request.mcpAuth;
 *   // ... handle request
 * });
 * ```
 */
export function withMcpAuth<T>(
  handler: (request: McpAuthenticatedRequest) => Promise<T>,
  options?: {
    requireScopes?: McpScope[]; // Require specific scopes
  },
) {
  return async (request: NextRequest): Promise<T | NextResponse> => {
    const requestLogger = createScopedLogger("mcp-auth");

    try {
      // Extract Bearer token from Authorization header
      const authHeader = request.headers.get("Authorization");

      if (!authHeader) {
        requestLogger.warn("Missing Authorization header");
        return createUnauthorizedResponse("Missing Authorization header");
      }

      const parts = authHeader.split(" ");
      if (parts.length !== 2 || parts[0] !== "Bearer") {
        requestLogger.warn("Invalid Authorization header format");
        return createUnauthorizedResponse(
          'Invalid Authorization header format. Expected "Bearer <token>"',
        );
      }

      const accessToken = parts[1];

      // Validate access token
      const jwtSecret = env.NEXTAUTH_SECRET || "fallback-secret-for-development";
      const tokenPayload = await validateAccessToken(accessToken, jwtSecret);

      if (!tokenPayload) {
        requestLogger.warn("Invalid or expired access token");
        return createUnauthorizedResponse("Invalid or expired access token");
      }

      // Check required scopes
      if (options?.requireScopes) {
        for (const requiredScope of options.requireScopes) {
          if (!hasScope(tokenPayload, requiredScope)) {
            requestLogger.warn("Insufficient scopes", {
              required: requiredScope,
              granted: tokenPayload.scope,
            });
            return createForbiddenResponse(
              `Insufficient permissions. Required scope: ${requiredScope}`,
            );
          }
        }
      }

      // Attach auth context to request
      const authenticatedRequest = request as McpAuthenticatedRequest;
      authenticatedRequest.mcpAuth = {
        token: tokenPayload,
        userId: tokenPayload.sub,
        emailAccountId: tokenPayload.email_account_id,
        clientId: tokenPayload.client_id,
        scopes: tokenPayload.scope.split(" ").filter(Boolean),
      };
      authenticatedRequest.logger = requestLogger;

      requestLogger.info("MCP request authenticated", {
        userId: tokenPayload.sub,
        emailAccountId: tokenPayload.email_account_id,
        clientId: tokenPayload.client_id,
      });

      // Call handler with authenticated request
      return await handler(authenticatedRequest);
    } catch (error) {
      if (error instanceof SafeError) {
        return createErrorResponse(error.message, 400);
      }

      requestLogger.error("MCP auth middleware error", { error });
      return createErrorResponse("Internal server error", 500);
    }
  };
}

/**
 * Create RFC 6750 compliant unauthorized response
 * https://datatracker.ietf.org/doc/html/rfc6750#section-3.1
 */
function createUnauthorizedResponse(errorDescription: string): NextResponse {
  return NextResponse.json(
    {
      error: "invalid_token",
      error_description: errorDescription,
    },
    {
      status: 401,
      headers: {
        "WWW-Authenticate": `Bearer realm="MCP Server", error="invalid_token", error_description="${errorDescription}"`,
      },
    },
  );
}

/**
 * Create RFC 6750 compliant forbidden response (insufficient scope)
 */
function createForbiddenResponse(errorDescription: string): NextResponse {
  return NextResponse.json(
    {
      error: "insufficient_scope",
      error_description: errorDescription,
    },
    {
      status: 403,
      headers: {
        "WWW-Authenticate": `Bearer realm="MCP Server", error="insufficient_scope", error_description="${errorDescription}"`,
      },
    },
  );
}

/**
 * Create generic error response
 */
function createErrorResponse(message: string, status: number): NextResponse {
  return NextResponse.json(
    {
      error: "invalid_request",
      error_description: message,
    },
    { status },
  );
}
