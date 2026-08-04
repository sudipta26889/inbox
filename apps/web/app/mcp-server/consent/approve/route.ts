import { NextResponse } from "next/server";
import { withAuth, type RequestWithAuth } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { generateSecureToken } from "@/utils/mcp-server/pkce";
import { validateRedirectUri } from "@/utils/mcp-server/redirect-uri";
import { validateScopes } from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";

export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}

/**
 * Consent Approval API
 *
 * This endpoint is called when the user clicks "Authorize" on the consent screen.
 * It generates an authorization code and returns the redirect URL.
 */
export const POST = withAuth(
  "mcp-server/consent/approve",
  async (request: RequestWithAuth) => {
    const logger = request.logger;
    const userId = request.auth.userId;

    const body = await request.json();
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      email_account_id: emailAccountId,
    } = body;

    // Validate required fields
    if (!clientId || !redirectUri || !codeChallenge || !emailAccountId) {
      throw new SafeError("Missing required parameters");
    }

    // Validate scopes
    if (!validateScopes(scope)) {
      throw new SafeError("Invalid scope");
    }

    // Verify client exists
    const client = await prisma.mcpServerClient.findUnique({
      where: { clientId },
    });

    if (!client) {
      throw new SafeError("Unknown client");
    }

    // Format-only check, same as /authorize — MCP clients use ephemeral localhost ports
    validateRedirectUri(redirectUri);

    // Verify email account belongs to user
    const emailAccount = await prisma.emailAccount.findFirst({
      where: {
        id: emailAccountId,
        userId,
      },
    });

    if (!emailAccount) {
      throw new SafeError("Invalid email account");
    }

    // Generate authorization code
    const code = generateSecureToken(32);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store authorization code
    await prisma.mcpServerAuthorizationCode.create({
      data: {
        code,
        redirectUri,
        scope: scope || "",
        state: state || "",
        codeChallenge,
        codeChallengeMethod: codeChallengeMethod || "S256",
        userId,
        emailAccountId,
        clientId,
        expiresAt,
      },
    });

    logger.info("User approved MCP client consent", {
      userId,
      emailAccountId,
      clientId,
      scope,
    });

    // Build redirect URL with authorization code
    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) {
      redirectUrl.searchParams.set("state", state);
    }

    return NextResponse.json({
      redirectUrl: redirectUrl.toString(),
    });
  },
);
