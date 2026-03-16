import { NextRequest, NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { env } from "@/env";
import { verifyCodeChallenge, validateCodeVerifier } from "@/utils/mcp-server/pkce";
import {
  generateAccessToken,
  refreshAccessToken,
} from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";

/**
 * OAuth 2.1 Token Endpoint
 * https://datatracker.ietf.org/doc/html/rfc6749#section-3.2
 *
 * This endpoint handles token requests from MCP clients.
 * It supports two grant types:
 * 1. authorization_code - Exchange authorization code for access token
 * 2. refresh_token - Refresh an expired access token
 *
 * All token exchanges require PKCE verification (OAuth 2.1 requirement).
 */
export const POST = withError("mcp-server/token", async (request: NextRequest) => {
  const logger = request.logger;

  // Parse form data (OAuth 2.1 requires application/x-www-form-urlencoded)
  const formData = await request.formData();
  const grantType = formData.get("grant_type")?.toString();
  const clientId = formData.get("client_id")?.toString();

  if (!grantType) {
    throw new SafeError("Missing required parameter: grant_type");
  }

  if (!clientId) {
    throw new SafeError("Missing required parameter: client_id");
  }

  // Verify client exists
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId },
  });

  if (!client) {
    logger.warn("Unknown client_id in token request", { clientId });
    throw new SafeError("Invalid client");
  }

  // Handle different grant types
  if (grantType === "authorization_code") {
    return await handleAuthorizationCodeGrant(formData, client, logger);
  } else if (grantType === "refresh_token") {
    return await handleRefreshTokenGrant(formData, client, logger);
  } else {
    throw new SafeError(
      `Unsupported grant_type: ${grantType}. Supported: authorization_code, refresh_token`,
    );
  }
});

/**
 * Handle authorization_code grant
 * Exchanges authorization code + PKCE verifier for access token
 */
async function handleAuthorizationCodeGrant(
  formData: FormData,
  client: any,
  logger: any,
): Promise<NextResponse> {
  const code = formData.get("code")?.toString();
  const redirectUri = formData.get("redirect_uri")?.toString();
  const codeVerifier = formData.get("code_verifier")?.toString();

  // Validate required parameters
  if (!code) {
    throw new SafeError("Missing required parameter: code");
  }

  if (!redirectUri) {
    throw new SafeError("Missing required parameter: redirect_uri");
  }

  if (!codeVerifier) {
    throw new SafeError(
      "Missing required parameter: code_verifier. PKCE is mandatory in OAuth 2.1",
    );
  }

  // Validate code verifier format
  if (!validateCodeVerifier(codeVerifier)) {
    throw new SafeError("Invalid code_verifier format");
  }

  // Look up authorization code
  const authCode = await prisma.mcpServerAuthorizationCode.findFirst({
    where: {
      code,
      clientId: client.clientId,
      used: false,
    },
  });

  if (!authCode) {
    logger.warn("Invalid or expired authorization code", { code });
    throw new SafeError("Invalid authorization code");
  }

  // Check if code has expired
  if (authCode.expiresAt < new Date()) {
    logger.warn("Authorization code expired", { code });
    throw new SafeError("Authorization code expired");
  }

  // Verify redirect_uri matches
  if (authCode.redirectUri !== redirectUri) {
    logger.warn("Redirect URI mismatch", {
      code,
      expected: authCode.redirectUri,
      received: redirectUri,
    });
    throw new SafeError("Invalid redirect_uri");
  }

  // Verify PKCE code_verifier matches code_challenge
  const pkceValid = verifyCodeChallenge(
    codeVerifier,
    authCode.codeChallenge,
    authCode.codeChallengeMethod as "S256" | "plain",
  );

  if (!pkceValid) {
    logger.warn("PKCE verification failed", { code });
    throw new SafeError("Invalid code_verifier");
  }

  // Mark authorization code as used (one-time use)
  await prisma.mcpServerAuthorizationCode.update({
    where: { id: authCode.id },
    data: {
      used: true,
      usedAt: new Date(),
    },
  });

  // Generate access token and refresh token
  const jwtSecret = env.NEXTAUTH_SECRET || "fallback-secret-for-development";

  const tokens = await generateAccessToken({
    userId: authCode.userId,
    emailAccountId: authCode.emailAccountId,
    clientId: client.clientId,
    scope: authCode.scope,
    jwtSecret,
  });

  logger.info("Issued MCP access token via authorization code", {
    userId: authCode.userId,
    emailAccountId: authCode.emailAccountId,
    clientId: client.clientId,
  });

  // Return tokens in OAuth 2.1 format
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
      scope: authCode.scope,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}

/**
 * Handle refresh_token grant
 * Exchanges refresh token for new access token
 */
async function handleRefreshTokenGrant(
  formData: FormData,
  client: any,
  logger: any,
): Promise<NextResponse> {
  const refreshToken = formData.get("refresh_token")?.toString();

  if (!refreshToken) {
    throw new SafeError("Missing required parameter: refresh_token");
  }

  // Refresh the access token
  const jwtSecret = env.NEXTAUTH_SECRET || "fallback-secret-for-development";
  const tokens = await refreshAccessToken(refreshToken, jwtSecret);

  if (!tokens) {
    logger.warn("Invalid or expired refresh token", { clientId: client.clientId });
    throw new SafeError("Invalid refresh token");
  }

  logger.info("Refreshed MCP access token", {
    clientId: client.clientId,
  });

  // Return new tokens
  return NextResponse.json(
    {
      access_token: tokens.accessToken,
      token_type: tokens.tokenType,
      expires_in: tokens.expiresIn,
      refresh_token: tokens.refreshToken,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
}
