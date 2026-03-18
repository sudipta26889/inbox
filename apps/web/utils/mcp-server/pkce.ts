import crypto from "node:crypto";

/**
 * PKCE (Proof Key for Code Exchange) - RFC 7636
 * https://datatracker.ietf.org/doc/html/rfc7636
 *
 * PKCE is mandatory in OAuth 2.1 to prevent authorization code interception attacks.
 * It works by:
 * 1. Client generates a random code_verifier
 * 2. Client hashes it to create code_challenge
 * 3. Client sends code_challenge with authorization request
 * 4. Server stores code_challenge with the authorization code
 * 5. Client sends code_verifier with token request
 * 6. Server verifies that hash(code_verifier) matches stored code_challenge
 */

export type CodeChallengeMethod = "S256" | "plain";

/**
 * Generate a cryptographically secure random code verifier
 * Must be 43-128 characters using [A-Z, a-z, 0-9, -, ., _, ~]
 */
export function generateCodeVerifier(): string {
  // Generate 32 random bytes (256 bits)
  const buffer = crypto.randomBytes(32);

  // Convert to base64url encoding (URL-safe)
  return base64UrlEncode(buffer);
}

/**
 * Create a code challenge from a code verifier
 * Supports both S256 (SHA-256) and plain methods
 */
export function createCodeChallenge(
  codeVerifier: string,
  method: CodeChallengeMethod = "S256",
): string {
  if (method === "plain") {
    // Plain method: challenge = verifier (not recommended, only for testing)
    return codeVerifier;
  }

  if (method === "S256") {
    // S256 method: challenge = base64url(sha256(verifier))
    const hash = crypto.createHash("sha256").update(codeVerifier).digest();
    return base64UrlEncode(hash);
  }

  throw new Error(`Unsupported code challenge method: ${method}`);
}

/**
 * Verify that a code verifier matches a stored code challenge
 * This is called during token exchange to validate PKCE
 */
export function verifyCodeChallenge(
  codeVerifier: string,
  codeChallenge: string,
  method: CodeChallengeMethod = "S256",
): boolean {
  try {
    const computedChallenge = createCodeChallenge(codeVerifier, method);
    return timingSafeEqual(computedChallenge, codeChallenge);
  } catch (error) {
    return false;
  }
}

/**
 * Validate that a code verifier meets RFC 7636 requirements
 * - Must be 43-128 characters
 * - Must use only unreserved characters [A-Za-z0-9-._~]
 */
export function validateCodeVerifier(codeVerifier: string): boolean {
  if (!codeVerifier) return false;

  // Check length (43-128 characters)
  if (codeVerifier.length < 43 || codeVerifier.length > 128) {
    return false;
  }

  // Check allowed characters
  const allowedChars = /^[A-Za-z0-9\-._~]+$/;
  return allowedChars.test(codeVerifier);
}

/**
 * Validate a code challenge method
 */
export function validateCodeChallengeMethod(
  method: string,
): method is CodeChallengeMethod {
  return method === "S256" || method === "plain";
}

/**
 * Convert Buffer to base64url encoding (URL-safe base64)
 * Removes padding (=) and replaces + with - and / with _
 */
function base64UrlEncode(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/**
 * Timing-safe string comparison to prevent timing attacks
 * Both strings must be the same length
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
 * Generate a secure random string for authorization codes and tokens
 * Returns a base64url-encoded random string
 */
export function generateSecureToken(bytes = 32): string {
  const buffer = crypto.randomBytes(bytes);
  return base64UrlEncode(buffer);
}
