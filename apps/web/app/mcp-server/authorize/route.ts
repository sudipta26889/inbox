import { NextRequest, NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { env } from "@/env";
import {
  validateCodeChallenge,
  validateCodeChallengeMethod,
  generateSecureToken,
} from "@/utils/mcp-server/pkce";
import { validateScopes } from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";
import { auth } from "@/utils/auth";

/**
 * OAuth 2.1 Authorization Endpoint
 * https://datatracker.ietf.org/doc/html/rfc6749#section-3.1
 *
 * This endpoint handles the authorization request from MCP clients.
 * It authenticates the user and obtains their consent, then redirects
 * back to the client with an authorization code.
 *
 * Flow:
 * 1. Client redirects user to this endpoint with parameters
 * 2. User authenticates (if not already logged in)
 * 3. User sees consent screen for the requested scopes
 * 4. User approves → redirect to client with authorization code
 * 5. User denies → redirect to client with error
 */
export const GET = withError("mcp-server/authorize", async (request: NextRequest) => {
  const logger = request.logger;
  const searchParams = request.nextUrl.searchParams;

  // Support base64-encoded oauth_state parameter (like MeetEcho)
  // This avoids WAF issues with URLs in query parameters
  const oauthState = searchParams.get("oauth_state");
  let clientId: string | null;
  let redirectUri: string | null;
  let responseType: string | null;
  let scope: string;
  let state: string;
  let codeChallenge: string | null;
  let codeChallengeMethod: string;

  if (oauthState) {
    // Decode base64 oauth_state parameter
    try {
      const decoded = Buffer.from(oauthState, "base64url").toString("utf-8");
      const params = new URLSearchParams(decoded);
      clientId = params.get("client_id");
      redirectUri = params.get("redirect_uri");
      responseType = params.get("response_type");
      scope = params.get("scope") || "";
      state = params.get("state") || "";
      codeChallenge = params.get("code_challenge");
      codeChallengeMethod = params.get("code_challenge_method") || "S256";
    } catch (error) {
      throw new SafeError("Invalid oauth_state parameter");
    }
  } else {
    // Standard OAuth parameters in query string
    clientId = searchParams.get("client_id");
    redirectUri = searchParams.get("redirect_uri");
    responseType = searchParams.get("response_type");
    scope = searchParams.get("scope") || "";
    state = searchParams.get("state") || "";
    codeChallenge = searchParams.get("code_challenge");
    codeChallengeMethod = searchParams.get("code_challenge_method") || "S256";
  }

  // Validate required parameters
  if (!clientId) {
    throw new SafeError("Missing required parameter: client_id");
  }

  if (!redirectUri) {
    throw new SafeError("Missing required parameter: redirect_uri");
  }

  if (responseType !== "code") {
    throw new SafeError(
      "Invalid response_type. Only 'code' is supported (authorization code flow)",
    );
  }

  // OAuth 2.1 requires PKCE for all clients
  if (!codeChallenge) {
    throw new SafeError(
      "Missing required parameter: code_challenge. PKCE is mandatory in OAuth 2.1",
    );
  }

  if (!validateCodeChallengeMethod(codeChallengeMethod)) {
    throw new SafeError(
      `Invalid code_challenge_method: ${codeChallengeMethod}. Must be 'S256' or 'plain'`,
    );
  }

  // Validate scopes
  if (!validateScopes(scope)) {
    throw new SafeError("Invalid scope requested");
  }

  // Verify client exists and redirect URI is registered
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId },
  });

  if (!client) {
    logger.warn("Unknown client_id in authorization request", { clientId });
    throw new SafeError("Unknown client");
  }

  if (!client.redirectUris.includes(redirectUri)) {
    logger.warn("Invalid redirect_uri for client", { clientId, redirectUri });
    throw new SafeError("Invalid redirect_uri");
  }

  // Check if user is authenticated
  const session = await auth();

  if (!session?.user?.id) {
    // User not logged in → redirect to login
    // Use base64-encoded oauth_state to avoid WAF issues
    const oauthParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: responseType || "code",
      scope,
      ...(state && { state }),
      ...(codeChallenge && { code_challenge: codeChallenge }),
      code_challenge_method: codeChallengeMethod,
    });

    const encodedState = Buffer.from(oauthParams.toString()).toString("base64url");
    const callbackUrl = `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/authorize?oauth_state=${encodedState}`;

    const loginUrl = new URL("/login", env.NEXT_PUBLIC_BASE_URL);
    loginUrl.searchParams.set("callbackUrl", callbackUrl);
    return NextResponse.redirect(loginUrl);
  }

  // Get user's email accounts
  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    include: {
      emailAccounts: {
        where: { accountId: { not: null } }, // Only connected accounts
        select: { id: true, email: true },
      },
    },
  });

  if (!user || user.emailAccounts.length === 0) {
    throw new SafeError("No email account connected. Please connect your email first.");
  }

  // For now, use the first email account
  // TODO: In the future, show account selector if user has multiple accounts
  const emailAccountId = user.emailAccounts[0].id;

  // Check if user has already approved this client with these scopes
  const existingApproval = await prisma.mcpServerAccessToken.findFirst({
    where: {
      userId: session.user.id,
      emailAccountId,
      clientId,
      scope,
      revoked: false,
      expiresAt: { gt: new Date() },
    },
  });

  // If user previously approved, skip consent screen
  const skipConsent = !!existingApproval;

  if (skipConsent) {
    // Generate authorization code immediately
    return await generateAndRedirectWithCode({
      userId: session.user.id,
      emailAccountId,
      clientId,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      logger,
    });
  }

  // Show consent screen using base64-encoded state to avoid WAF issues
  const consentParams = new URLSearchParams({
    client_id: clientId,
    client_name: client.clientName,
    redirect_uri: redirectUri,
    scope,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: codeChallengeMethod,
    email_account_id: emailAccountId,
  });

  const encodedConsent = Buffer.from(consentParams.toString()).toString("base64url");
  const consentUrl = new URL("/mcp-server/consent", env.NEXT_PUBLIC_BASE_URL);
  consentUrl.searchParams.set("oauth_state", encodedConsent);

  return NextResponse.redirect(consentUrl);
});

/**
 * Generate authorization code and redirect back to client
 */
async function generateAndRedirectWithCode({
  userId,
  emailAccountId,
  clientId,
  redirectUri,
  scope,
  state,
  codeChallenge,
  codeChallengeMethod,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  logger: any;
}): Promise<NextResponse> {
  // Generate authorization code
  const code = generateSecureToken(32);
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

  // Store authorization code in database
  await prisma.mcpServerAuthorizationCode.create({
    data: {
      code,
      redirectUri,
      scope,
      state,
      codeChallenge,
      codeChallengeMethod,
      userId,
      emailAccountId,
      clientId,
      expiresAt,
    },
  });

  logger.info("Generated MCP authorization code", {
    userId,
    emailAccountId,
    clientId,
    scope,
  });

  // Redirect back to client with authorization code
  const redirectUrl = new URL(redirectUri);
  redirectUrl.searchParams.set("code", code);
  if (state) {
    redirectUrl.searchParams.set("state", state);
  }

  return NextResponse.redirect(redirectUrl);
}
