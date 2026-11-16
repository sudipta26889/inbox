import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { env } from "@/env";
import {
  isMcpResource,
  issueAuthorizationCode,
} from "@/utils/mcp-server/authorization-code";
import {
  checkIpRateLimit,
  createRateLimitResponse,
  getClientIp,
} from "@/utils/a2a/rate-limit";
import { resolveClientMetadata } from "@/utils/mcp-server/client-metadata";
import { validateCodeChallengeMethod } from "@/utils/mcp-server/pkce";
import {
  redirectUriMatches,
  validateRedirectUri,
} from "@/utils/mcp-server/redirect-uri";
import { validateScopes } from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";
import { auth } from "@/utils/auth";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

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
export const GET = withError(
  "mcp-server/authorize",
  async (request: RequestWithLogger) => {
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
    let resource: string | null;

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
        resource = params.get("resource");
      } catch {
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
      resource = searchParams.get("resource");
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
        `invalid_request: unsupported code_challenge_method '${codeChallengeMethod}'. Only 'S256' is supported`,
      );
    }

    if (resource && !isMcpResource(resource)) {
      throw new SafeError("invalid_target: unknown resource");
    }

    // Auto-add calendar:write if calendar:read is present
    // This works around MCP clients that don't request calendar:write yet
    let finalScope = scope;
    if (
      finalScope.includes("calendar:read") &&
      !finalScope.includes("calendar:write")
    ) {
      const scopeParts = finalScope.split(" ");
      scopeParts.push("calendar:write");
      finalScope = scopeParts.join(" ");
    }

    // Validate scopes
    if (!validateScopes(finalScope)) {
      throw new SafeError("Invalid scope requested");
    }

    validateRedirectUri(redirectUri);

    // A URL client_id is a metadata-document client. It is fetched only once the
    // user is signed in, so an anonymous request can't make the server fetch.
    const isMetadataClient = clientId.startsWith("https://");

    if (!isMetadataClient) {
      const client = await prisma.mcpServerClient.findUnique({
        where: { clientId },
      });

      if (!client) {
        logger.warn("Unknown client_id in authorization request", { clientId });
        throw new SafeError("Unknown client");
      }

      if (!redirectUriMatches(redirectUri, client.redirectUris)) {
        logger.warn("redirect_uri does not match the client's registration", {
          clientId,
        });
        throw new SafeError("redirect_uri is not registered for this client");
      }
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
        scope: finalScope,
        ...(state && { state }),
        ...(codeChallenge && { code_challenge: codeChallenge }),
        code_challenge_method: codeChallengeMethod,
        ...(resource && { resource }),
      });

      const encodedState = Buffer.from(oauthParams.toString()).toString(
        "base64url",
      );
      const callbackUrl = `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/authorize?oauth_state=${encodedState}`;

      const loginUrl = new URL("/login", env.NEXT_PUBLIC_BASE_URL);
      loginUrl.searchParams.set("callbackUrl", callbackUrl);
      return NextResponse.redirect(loginUrl);
    }

    if (isMetadataClient) {
      const rateLimit = await checkIpRateLimit(getClientIp(request));
      if (!rateLimit.allowed) {
        const { status, headers, body } = createRateLimitResponse(rateLimit);
        return NextResponse.json(body, { status, headers });
      }
      await resolveClientMetadata(clientId, redirectUri);
    }

    // Get user's email accounts
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      include: {
        emailAccounts: {
          select: { id: true, email: true },
        },
      },
    });

    if (!user || user.emailAccounts.length === 0) {
      throw new SafeError(
        "No email account connected. Please connect your email first.",
      );
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
        scope: finalScope,
        revoked: false,
        expiresAt: { gt: new Date() },
      },
    });

    // If user previously approved, skip consent screen
    const skipConsent = !!existingApproval;

    if (skipConsent) {
      // Generate authorization code immediately
      const redirectUrl = await issueAuthorizationCode({
        userId: session.user.id,
        emailAccountId,
        clientId,
        redirectUri,
        scope: finalScope,
        state,
        codeChallenge,
        codeChallengeMethod,
      });
      logger.info("Generated MCP authorization code", {
        userId: session.user.id,
        emailAccountId,
        clientId,
        scope: finalScope,
      });
      return NextResponse.redirect(redirectUrl);
    }

    // Show consent screen using base64-encoded state to avoid WAF issues
    const consentParams = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: finalScope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      email_account_id: emailAccountId,
    });

    const encodedConsent = Buffer.from(consentParams.toString()).toString(
      "base64url",
    );
    const consentUrl = new URL("/mcp-server/consent", env.NEXT_PUBLIC_BASE_URL);
    consentUrl.searchParams.set("oauth_state", encodedConsent);

    return NextResponse.redirect(consentUrl);
  },
);
