import crypto from "node:crypto";
import { generateSecureToken } from "./pkce";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { MCP_SCOPES, TOKEN_CONFIG, type McpScope } from "./constants";

const logger = createScopedLogger("mcp-server-tokens");

// Re-export for convenience
export { MCP_SCOPES, type McpScope };

/**
 * JWT token payload structure
 */
export interface McpTokenPayload {
  client_id: string; // Client ID
  email: string; // User email
  email_account_id: string; // Email account ID
  exp: number; // Expiration timestamp
  iat: number; // Issued at timestamp
  jti: string; // JWT ID (token ID)
  scope: string; // Space-separated scopes
  sub: string; // Subject (user ID)
  token_type: "access" | "refresh";
}

/**
 * Create a signed JWT token using HMAC-SHA256
 * This is a simplified JWT implementation - in production you might want to use
 * the 'jose' library for full JWT/JWS support
 */
export function createJwtToken(
  payload: McpTokenPayload,
  secret: string,
): string {
  // JWT Header
  const header = {
    alg: "HS256",
    typ: "JWT",
  };

  // Base64url encode header and payload
  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));

  // Create signature: HMAC-SHA256(header.payload, secret)
  const data = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto
    .createHmac("sha256", secret)
    .update(data)
    .digest("base64url");

  // Return complete JWT: header.payload.signature
  return `${data}.${signature}`;
}

/**
 * Verify and decode a JWT token
 */
export function verifyJwtToken(
  token: string,
  secret: string,
): McpTokenPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) {
      logger.warn("Invalid JWT format");
      return null;
    }

    const [encodedHeader, encodedPayload, signature] = parts;

    // Verify signature
    const data = `${encodedHeader}.${encodedPayload}`;
    const expectedSignature = crypto
      .createHmac("sha256", secret)
      .update(data)
      .digest("base64url");

    if (!timingSafeEqual(signature, expectedSignature)) {
      logger.warn("Invalid JWT signature");
      return null;
    }

    // Decode and parse payload
    const payloadJson = Buffer.from(encodedPayload, "base64url").toString(
      "utf8",
    );
    const payload = JSON.parse(payloadJson) as McpTokenPayload;

    // Verify expiration
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      logger.warn("JWT token expired");
      return null;
    }

    return payload;
  } catch (error) {
    logger.error("Failed to verify JWT token", { error });
    return null;
  }
}

/**
 * Generate and store an access token for a user
 */
export async function generateAccessToken({
  userId,
  emailAccountId,
  clientId,
  scope,
  jwtSecret,
}: {
  userId: string;
  emailAccountId: string;
  clientId: string;
  scope: string;
  jwtSecret: string;
}): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
}> {
  const now = Math.floor(Date.now() / 1000);
  const jti = generateSecureToken();

  // Get user email for token payload
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true },
  });

  if (!user) {
    throw new Error("User not found");
  }

  // Create access token payload
  const accessTokenPayload: McpTokenPayload = {
    sub: userId,
    email: user.email,
    email_account_id: emailAccountId,
    scope,
    client_id: clientId,
    exp: now + TOKEN_CONFIG.ACCESS_TOKEN_TTL,
    iat: now,
    jti: jti,
    token_type: "access",
  };

  // Create refresh token payload (longer TTL, different JTI)
  const refreshTokenJti = generateSecureToken();
  const refreshTokenPayload: McpTokenPayload = {
    ...accessTokenPayload,
    exp: now + TOKEN_CONFIG.REFRESH_TOKEN_TTL,
    jti: refreshTokenJti,
    token_type: "refresh",
  };

  // Sign tokens
  const accessToken = createJwtToken(accessTokenPayload, jwtSecret);
  const refreshToken = createJwtToken(refreshTokenPayload, jwtSecret);

  // Store in database
  await prisma.mcpServerAccessToken.create({
    data: {
      accessToken: jti, // Store JTI, not full token (for revocation)
      refreshToken: refreshTokenJti,
      tokenType: "Bearer",
      scope,
      expiresAt: new Date((now + TOKEN_CONFIG.ACCESS_TOKEN_TTL) * 1000),
      userId,
      emailAccountId,
      clientId,
    },
  });

  logger.info("Generated MCP access token", {
    userId,
    emailAccountId,
    clientId,
    scope,
  });

  return {
    accessToken,
    refreshToken,
    expiresIn: TOKEN_CONFIG.ACCESS_TOKEN_TTL,
    tokenType: "Bearer",
  };
}

/**
 * Validate an access token and return its payload
 * Also checks if the token has been revoked
 */
export async function validateAccessToken(
  accessToken: string,
  jwtSecret: string,
): Promise<McpTokenPayload | null> {
  // Verify and decode JWT
  const payload = verifyJwtToken(accessToken, jwtSecret);
  if (!payload) {
    return null;
  }

  // Check if token has been revoked in database
  const tokenRecord = await prisma.mcpServerAccessToken.findFirst({
    where: {
      accessToken: payload.jti,
      revoked: false,
    },
  });

  if (!tokenRecord) {
    logger.warn("Access token not found or revoked", { jti: payload.jti });
    return null;
  }

  // Update last used timestamp
  await prisma.mcpServerAccessToken.update({
    where: { id: tokenRecord.id },
    data: { lastUsedAt: new Date() },
  });

  return payload;
}

/**
 * Refresh an access token using a refresh token
 */
export async function refreshAccessToken(
  refreshToken: string,
  jwtSecret: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
} | null> {
  // Verify refresh token
  const payload = verifyJwtToken(refreshToken, jwtSecret);
  if (!payload || payload.token_type !== "refresh") {
    logger.warn("Invalid refresh token");
    return null;
  }

  // Check if refresh token exists and is not revoked
  const tokenRecord = await prisma.mcpServerAccessToken.findFirst({
    where: {
      refreshToken: payload.jti,
      revoked: false,
    },
  });

  if (!tokenRecord) {
    logger.warn("Refresh token not found or revoked", { jti: payload.jti });
    return null;
  }

  // Generate new access token (and new refresh token)
  const newTokens = await generateAccessToken({
    userId: payload.sub,
    emailAccountId: payload.email_account_id,
    clientId: payload.client_id,
    scope: payload.scope,
    jwtSecret,
  });

  // Revoke old tokens
  await prisma.mcpServerAccessToken.update({
    where: { id: tokenRecord.id },
    data: {
      revoked: true,
      revokedAt: new Date(),
    },
  });

  logger.info("Refreshed MCP access token", {
    userId: payload.sub,
    clientId: payload.client_id,
  });

  return newTokens;
}

/**
 * Revoke an access token
 */
export async function revokeAccessToken(
  accessToken: string,
  jwtSecret: string,
): Promise<boolean> {
  const payload = verifyJwtToken(accessToken, jwtSecret);
  if (!payload) {
    return false;
  }

  const result = await prisma.mcpServerAccessToken.updateMany({
    where: {
      accessToken: payload.jti,
      revoked: false,
    },
    data: {
      revoked: true,
      revokedAt: new Date(),
    },
  });

  logger.info("Revoked MCP access token", { jti: payload.jti });
  return result.count > 0;
}

/**
 * Validate that a scope string contains only valid scopes
 */
export function validateScopes(scopeString: string): boolean {
  if (!scopeString) return true; // Empty scope is valid

  const scopes = scopeString.split(" ");
  return scopes.every((scope) => scope in MCP_SCOPES);
}

/**
 * Check if a token has a specific scope
 */
export function hasScope(
  payload: McpTokenPayload,
  requiredScope: McpScope,
): boolean {
  const scopes = payload.scope.split(" ");
  return scopes.includes(requiredScope);
}

/**
 * Base64url encode a string
 */
function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Timing-safe string comparison
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Get token configuration
 */
export function getTokenConfig() {
  return TOKEN_CONFIG;
}
