import { NextRequest, NextResponse } from "next/server";
import { env } from "@/env";
import { verifyCodeChallenge, validateCodeVerifier } from "@/utils/mcp-server/pkce";
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
  return NextResponse.json(
    { error, error_description: errorDescription },
    { status, headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" } }
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
      return oauthError("invalid_request", "Missing required parameter: grant_type");
    }

    if (!clientId) {
      return oauthError("invalid_request", "Missing required parameter: client_id");
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
      return oauthError("unsupported_grant_type", `Unsupported grant_type: ${grantType}`);
    }
  } catch (error: any) {
    logger.error("Token endpoint error", { error: error.message });
    return oauthError("server_error", error.message || "Internal server error", 500);
  }
}

async function handleAuthorizationCodeGrant(formData: FormData, client: any) {
  const code = formData.get("code")?.toString();
  const redirectUri = formData.get("redirect_uri")?.toString();
  const codeVerifier = formData.get("code_verifier")?.toString();

  if (!code) {
    return oauthError("invalid_request", "Missing required parameter: code");
  }
  if (!redirectUri) {
    return oauthError("invalid_request", "Missing required parameter: redirect_uri");
  }
  if (!codeVerifier) {
    return oauthError("invalid_request", "Missing required parameter: code_verifier");
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

  if (authCode.redirectUri !== redirectUri) {
    return oauthError("invalid_grant", "redirect_uri mismatch");
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
  const tokens = await generateAccessToken({
    userId: authCode.userId,
    emailAccountId: authCode.emailAccountId,
    clientId: client.clientId,
    scope: authCode.scope || "",
    jwtSecret,
  });

  logger.info("Issued MCP access token via authorization code", {
    userId: authCode.userId,
    clientId: client.clientId,
  });

  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: authCode.scope,
    },
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

async function handleRefreshTokenGrant(formData: FormData, client: any) {
  const refreshToken = formData.get("refresh_token")?.toString();

  if (!refreshToken) {
    return oauthError("invalid_request", "Missing required parameter: refresh_token");
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
    { headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}
