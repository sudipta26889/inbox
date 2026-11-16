import { NextResponse } from "next/server";
import { withAuth, type RequestWithAuth } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { BASE, EMAIL_OTP_REFUSAL } from "@/utils/mcp-server/constants";
import {
  buildRedirectUrl,
  issueAuthorizationCode,
} from "@/utils/mcp-server/authorization-code";
import {
  redirectUriMatches,
  validateRedirectUri,
} from "@/utils/mcp-server/redirect-uri";
import {
  isValidCodeChallenge,
  validateCodeChallengeMethod,
} from "@/utils/mcp-server/pkce";
import { validateScopes } from "@/utils/mcp-server/tokens";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";

// next.config sends `Access-Control-Allow-Origin: *` on /mcp-server/*, this
// route included. What protects it is the exact Origin check in POST, not CORS.
export async function OPTIONS() {
  return new NextResponse(null, { status: 204 });
}

/**
 * Consent Approval API
 *
 * Called when the user clicks "Authorize" or "Deny" on the consent screen.
 * Approve returns the redirect URL carrying an authorization code; deny
 * returns one carrying access_denied. Both validate the client and redirect
 * URI here, so a tampered page can't turn this into an open redirect.
 */
export const POST = withAuth(
  "mcp-server/consent/approve",
  async (request: RequestWithAuth) => {
    // The session cookie alone would let any site that can make the browser
    // POST here approve a client on the user's behalf.
    if (request.headers.get("Origin") !== BASE) {
      return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
    }

    const logger = request.logger;
    const userId = request.auth.userId;

    // Upstream's invariant: an email-code session cannot authorize apps.
    if (request.auth.emailOtp) {
      logger.warn("Refused MCP consent from an email code session");
      return NextResponse.json(
        { error: "access_denied", error_description: EMAIL_OTP_REFUSAL },
        { status: 403 },
      );
    }

    const body = await request.json();
    const {
      client_id: clientId,
      redirect_uri: redirectUri,
      scope,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: codeChallengeMethod,
      email_account_id: emailAccountId,
      deny,
    } = body;

    if (!clientId || !redirectUri) {
      throw new SafeError("Missing required parameters");
    }

    const client = await prisma.mcpServerClient.findUnique({
      where: { clientId },
    });

    if (!client) {
      throw new SafeError("Unknown client");
    }

    validateRedirectUri(redirectUri);
    if (!redirectUriMatches(redirectUri, client.redirectUris)) {
      throw new SafeError("redirect_uri is not registered for this client");
    }

    if (deny === true) {
      logger.info("User denied MCP client consent", { userId, clientId });
      return NextResponse.json({
        redirectUrl: buildRedirectUrl(redirectUri, {
          error: "access_denied",
          error_description: "User denied access",
          state,
        }),
      });
    }

    if (!codeChallenge || !emailAccountId) {
      throw new SafeError("Missing required parameters");
    }

    if (!isValidCodeChallenge(codeChallenge)) {
      throw new SafeError(
        "invalid_request: code_challenge must be a 43-character base64url S256 challenge",
      );
    }

    if (
      codeChallengeMethod &&
      !validateCodeChallengeMethod(codeChallengeMethod)
    ) {
      throw new SafeError(
        "invalid_request: unsupported code_challenge_method. Only 'S256' is supported",
      );
    }

    if (!validateScopes(scope) || exceedsClientScope(scope, client.scope)) {
      throw new SafeError("Invalid scope");
    }

    const emailAccount = await prisma.emailAccount.findFirst({
      where: {
        id: emailAccountId,
        ...accessibleEmailAccountWhere(userId),
      },
    });

    if (!emailAccount) {
      throw new SafeError("Invalid email account");
    }

    const redirectUrl = await issueAuthorizationCode({
      userId,
      emailAccountId,
      clientId,
      redirectUri,
      scope: scope || "",
      state,
      codeChallenge,
      codeChallengeMethod: codeChallengeMethod || "S256",
    });

    logger.info("User approved MCP client consent", {
      userId,
      emailAccountId,
      clientId,
      scope,
    });

    return NextResponse.json({ redirectUrl });
  },
);

// calendar:write is added automatically whenever calendar:read is requested,
// so a client registered for read may be granted it.
function exceedsClientScope(
  requested: string | undefined,
  registered: string | null,
): boolean {
  if (!registered || !requested) return false;
  const allowed = new Set(registered.split(" ").filter(Boolean));
  if (allowed.has("calendar:read")) allowed.add("calendar:write");
  return requested
    .split(" ")
    .filter(Boolean)
    .some((scope) => !allowed.has(scope));
}
