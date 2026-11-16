import crypto from "node:crypto";
import prisma from "@/utils/prisma";
import { BASE, MCP_RESOURCE, TOKEN_CONFIG } from "./constants";
import { generateSecureToken } from "./pkce";

/**
 * Create an authorization code and return the URL to send the user back to.
 * Only sha256(code) is stored, so a database read cannot be replayed at /token.
 */
export async function issueAuthorizationCode({
  userId,
  emailAccountId,
  clientId,
  redirectUri,
  scope,
  state,
  codeChallenge,
  codeChallengeMethod,
}: {
  userId: string;
  emailAccountId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state?: string | null;
  codeChallenge: string;
  codeChallengeMethod: string;
}): Promise<string> {
  const code = generateSecureToken(32);

  await prisma.mcpServerAuthorizationCode.create({
    data: {
      code: hashAuthorizationCode(code),
      redirectUri,
      scope,
      state: state || "",
      codeChallenge,
      codeChallengeMethod,
      userId,
      emailAccountId,
      clientId,
      grantId: crypto.randomUUID(),
      expiresAt: new Date(
        Date.now() + TOKEN_CONFIG.AUTHORIZATION_CODE_TTL * 1000,
      ),
    },
  });

  return buildRedirectUrl(redirectUri, { code, state });
}

export function buildRedirectUrl(
  redirectUri: string,
  params: Record<string, string | null | undefined>,
): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value) url.searchParams.set(key, value);
  }
  url.searchParams.set("iss", BASE);
  return url.toString();
}

export function hashAuthorizationCode(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

// RFC 8707: the only resource this server issues tokens for is itself. One
// trailing slash is tolerated because clients differ on it.
export function isMcpResource(resource: string): boolean {
  return resource.replace(/\/$/, "") === MCP_RESOURCE;
}
