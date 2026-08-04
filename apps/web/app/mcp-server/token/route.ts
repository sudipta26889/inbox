import type { McpServerClient } from "@prisma/client";
import { type NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import {
  verifyCodeChallenge,
  validateCodeVerifier,
} from "@/utils/mcp-server/pkce";
import {
  generateAccessToken,
  refreshAccessToken,
} from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("mcp-server/token");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * OPTIONS /mcp-server/token - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * RFC 6749 compliant OAuth error response
 */
function oauthError(error: string, errorDescription: string, status = 400) {
  logger.warn("Token request rejected", { error, errorDescription });
  return NextResponse.json(
    { error, error_description: errorDescription },
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

/**
 * OAuth 2.1 Token Endpoint (RFC 6749 Section 3.2)
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const grantType = formData.get("grant_type")?.toString();
    const clientId = formData.get("client_id")?.toString();

    if (!grantType) {
      return oauthError(
        "invalid_request",
        "Missing required parameter: grant_type",
      );
    }

    if (!clientId) {
      return oauthError(
        "invalid_request",
        "Missing required parameter: client_id",
      );
    }

    const client = await prisma.mcpServerClient.findUnique({
      where: { clientId },
    });

    if (!client) {
      return oauthError("invalid_client", "Unknown client_id");
    }

    if (grantType === "authorization_code") {
      return await handleAuthorizationCodeGrant(formData, client);
    } else if (grantType === "refresh_token") {
      return await handleRefreshTokenGrant(formData, client);
    } else {
      return oauthError(
        "unsupported_grant_type",
        `Unsupported grant_type: ${grantType}`,
      );
    }
  } catch (error) {
    logger.error("Token endpoint error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return oauthError(
      "server_error",
      error instanceof Error ? error.message : "Internal server error",
      500,
    );
  }
}

async function handleAuthorizationCodeGrant(
  formData: FormData,
  client: McpServerClient,
) {
  const code = formData.get("code")?.toString();
  const redirectUri = formData.get("redirect_uri")?.toString();
  const codeVerifier = formData.get("code_verifier")?.toString();

  if (!code) {
    return oauthError("invalid_request", "Missing required parameter: code");
  }
  if (!codeVerifier) {
    return oauthError(
      "invalid_request",
      "Missing required parameter: code_verifier",
    );
  }
  if (!validateCodeVerifier(codeVerifier)) {
    return oauthError("invalid_request", "Invalid code_verifier format");
  }

  const authCode = await prisma.mcpServerAuthorizationCode.findFirst({
    where: { code, clientId: client.clientId, used: false },
  });

  if (!authCode) {
    return oauthError("invalid_grant", "Invalid authorization code");
  }

  if (authCode.expiresAt < new Date()) {
    return oauthError("invalid_grant", "Authorization code expired");
  }

  // OAuth 2.1: PKCE binds the code to the client, so the legacy redirect_uri
  // equality check is dropped — it rejects clients that send variants of the
  // same callback (localhost vs 127.0.0.1, trailing slash). Log for visibility.
  if (redirectUri && authCode.redirectUri !== redirectUri) {
    logger.info("Token redirect_uri differs from authorization request", {
      stored: authCode.redirectUri,
      received: redirectUri,
    });
  }

  const pkceValid = verifyCodeChallenge(
    codeVerifier,
    authCode.codeChallenge,
    authCode.codeChallengeMethod as "S256" | "plain",
  );

  if (!pkceValid) {
    return oauthError("invalid_grant", "Invalid code_verifier");
  }

  await prisma.mcpServerAuthorizationCode.update({
    where: { id: authCode.id },
    data: { used: true, usedAt: new Date() },
  });

  const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";

  // Auto-add calendar:write if calendar:read is present
  // This works around MCP clients that don't request calendar:write yet
  let finalScope = authCode.scope || "";
  if (
    finalScope.includes("calendar:read") &&
    !finalScope.includes("calendar:write")
  ) {
    finalScope += " calendar:write";
  }

  const tokens = await generateAccessToken({
    userId: authCode.userId,
    emailAccountId: authCode.emailAccountId,
    clientId: client.clientId,
    scope: finalScope,
    jwtSecret,
  });

  logger.info("Issued MCP access token via authorization code", {
    userId: authCode.userId,
    clientId: client.clientId,
    scope: finalScope,
  });

  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: finalScope,
    },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

async function handleRefreshTokenGrant(
  formData: FormData,
  client: McpServerClient,
) {
  const refreshToken = formData.get("refresh_token")?.toString();

  if (!refreshToken) {
    return oauthError(
      "invalid_request",
      "Missing required parameter: refresh_token",
    );
  }

  const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";
  const tokens = await refreshAccessToken(refreshToken, jwtSecret);

  if (!tokens) {
    return oauthError("invalid_grant", "Invalid or expired refresh token");
  }

  logger.info("Refreshed MCP access token", { clientId: client.clientId });

  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
    },
    {
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}
