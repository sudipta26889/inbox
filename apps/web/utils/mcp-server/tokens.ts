import crypto from "node:crypto";
import { generateSecureToken } from "./pkce";
import prisma from "@/utils/prisma";
import { createScopedLogger } from "@/utils/logger";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import {
  MCP_RESOURCE,
  MCP_SCOPES,
  REFRESH_REPLAY_GRACE_SECONDS,
  TOKEN_CONFIG,
  type McpScope,
} from "./constants";

const logger = createScopedLogger("mcp-server-tokens");

// Re-export for convenience
export { MCP_SCOPES, type McpScope };

/**
 * JWT token payload structure
 */
export interface McpTokenPayload {
  aud?: string; // Audience: the MCP resource URL (RFC 8707); absent on tokens minted before it was added
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
  // HMAC with an empty key is forgeable by anyone; fail closed when
  // AUTH_SECRET/NEXTAUTH_SECRET are unset instead of signing with "".
  if (!secret) throw new Error("MCP token secret is not configured");

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
  if (!secret) {
    logger.error("MCP token secret is not configured; refusing all tokens");
    return null;
  }

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
  // Opt-in override for peers that cannot run an OAuth refresh loop. The
  // resulting token is an ordinary access token — same signature, same
  // revocation check — it just expires far later. Default is unchanged.
  accessTokenTtlSeconds = TOKEN_CONFIG.ACCESS_TOKEN_TTL,
  // Ties tokens from one authorization (and its refreshes) together so a
  // replay can revoke them as a set. Static A2A tokens have none.
  grantId,
}: {
  userId: string;
  emailAccountId: string;
  clientId: string;
  scope: string;
  jwtSecret: string;
  accessTokenTtlSeconds?: number;
  grantId?: string | null;
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
    aud: MCP_RESOURCE,
    sub: userId,
    email: user.email,
    email_account_id: emailAccountId,
    scope,
    client_id: clientId,
    exp: now + accessTokenTtlSeconds,
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
      expiresAt: new Date((now + accessTokenTtlSeconds) * 1000),
      userId,
      emailAccountId,
      clientId,
      grantId: grantId ?? null,
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
    expiresIn: accessTokenTtlSeconds,
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
 * Refresh an access token using a refresh token.
 *
 * Rotation keeps the grant: the old row is marked `rotated` and the new one
 * carries the same grantId. Presenting a rotated token again after the grace
 * window means two parties hold it, so the whole grant is revoked.
 */
export async function refreshAccessToken(
  refreshToken: string,
  jwtSecret: string,
  expectedClientId: string,
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  tokenType: string;
} | null> {
  const payload = verifyJwtToken(refreshToken, jwtSecret);
  if (payload?.token_type !== "refresh") {
    logger.warn("Invalid refresh token");
    return null;
  }

  if (payload.client_id !== expectedClientId) {
    logger.warn("Refresh token presented by a different client", {
      jti: payload.jti,
    });
    return null;
  }

  const row = await prisma.mcpServerAccessToken.findFirst({
    where: { refreshToken: payload.jti },
    select: {
      revoked: true,
      revokedReason: true,
      revokedAt: true,
      grantId: true,
    },
  });
  if (!row) {
    logger.warn("Refresh token not found", { jti: payload.jti });
    return null;
  }

  if (row.revoked) {
    await revokeGrantOnReplay(row, payload.jti);
    return null;
  }

  // Same lookup buildMcpToolContext uses: a token must not outlive access to
  // the account it is bound to.
  const stillHasAccess = await prisma.emailAccount.findFirst({
    where: {
      id: payload.email_account_id,
      ...accessibleEmailAccountWhere(payload.sub),
    },
    select: { id: true },
  });
  if (!stillHasAccess) {
    logger.warn("Refresh refused: user lost access to the email account", {
      jti: payload.jti,
    });
    return null;
  }

  // Revoke before issuing, in one conditional write: of two concurrent
  // refreshes with the same token only one can claim it, so a race cannot
  // leave an extra live token pair behind.
  const claimed = await prisma.mcpServerAccessToken.updateMany({
    where: {
      refreshToken: payload.jti,
      revoked: false,
    },
    data: {
      revoked: true,
      revokedAt: new Date(),
      revokedReason: "rotated",
    },
  });

  if (claimed.count === 0) {
    logger.warn("Refresh token already claimed", { jti: payload.jti });
    return null;
  }

  const newTokens = await generateAccessToken({
    userId: payload.sub,
    emailAccountId: payload.email_account_id,
    clientId: payload.client_id,
    scope: payload.scope,
    jwtSecret,
    // Grants issued before grantId existed gain replay protection here.
    grantId: row.grantId ?? crypto.randomUUID(),
  });

  logger.info("Refreshed MCP access token", {
    userId: payload.sub,
    clientId: payload.client_id,
  });

  return newTokens;
}

async function revokeGrantOnReplay(
  row: {
    revokedReason: string | null;
    revokedAt: Date | null;
    grantId: string | null;
  },
  jti: string,
) {
  if (row.revokedReason !== "rotated" || !row.grantId || !row.revokedAt) {
    logger.warn("Refresh token revoked", { jti, reason: row.revokedReason });
    return;
  }

  const ageSeconds = (Date.now() - row.revokedAt.getTime()) / 1000;
  // The grace window only avoids revoking the grant; a retried or concurrent refresh
  // still gets invalid_grant, as it did before this change.
  if (ageSeconds <= REFRESH_REPLAY_GRACE_SECONDS) {
    logger.warn("Refresh token reused inside the grace window", { jti });
    return;
  }

  // Rows already revoked keep their reason (a user revoke stays a user revoke).
  const result = await prisma.mcpServerAccessToken.updateMany({
    where: { grantId: row.grantId, revoked: false },
    data: { revoked: true, revokedAt: new Date(), revokedReason: "reuse" },
  });
  logger.warn("Rotated refresh token replayed; grant revoked", {
    jti,
    revokedTokens: result.count,
  });
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

  // RFC 7009 accepts either token. The pair shares one row, so revoking it
  // by whichever jti was presented ends both.
  const result = await prisma.mcpServerAccessToken.updateMany({
    where: {
      ...(payload.token_type === "refresh"
        ? { refreshToken: payload.jti }
        : { accessToken: payload.jti }),
      revoked: false,
    },
    data: {
      revoked: true,
      revokedAt: new Date(),
      revokedReason: "user",
    },
  });

  logger.info("Revoked MCP token", {
    jti: payload.jti,
    tokenType: payload.token_type,
  });
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
