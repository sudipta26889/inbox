import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getLinkingOAuth2Url } from "@/utils/outlook/client";
import { OUTLOOK_LINKING_STATE_COOKIE_NAME } from "@/utils/outlook/constants";
import { SCOPES as OUTLOOK_SCOPES } from "@/utils/outlook/scopes";
import { findReconnectTarget } from "@/utils/oauth/reconnect-target";
import {
  generateOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";

export type GetOutlookAuthLinkUrlResponse = { url: string };

const getAuthUrl = ({
  userId,
  reconnectTarget,
}: {
  userId: string;
  reconnectTarget: { id: string; email: string } | null;
}) => {
  const state = generateOAuthState({
    userId,
    ...(reconnectTarget && { reconnectEmailAccountId: reconnectTarget.id }),
  });

  const baseUrl = getLinkingOAuth2Url();
  const loginHint = reconnectTarget
    ? `&login_hint=${encodeURIComponent(reconnectTarget.email)}`
    : "";
  const url = `${baseUrl}&state=${state}${loginHint}`;

  return { url, state };
};

export const GET = withAuth("outlook/linking/auth-url", async (request) => {
  const userId = request.auth.userId;
  // Not request.nextUrl: withAuth hands over a cloned request without it.
  const reconnectEmailAccountId = new URL(request.url).searchParams.get(
    "emailAccountId",
  );
  const reconnectTarget = reconnectEmailAccountId
    ? await findReconnectTarget({
        emailAccountId: reconnectEmailAccountId,
        userId,
        provider: "microsoft",
      })
    : null;

  if (reconnectEmailAccountId && !reconnectTarget) {
    return NextResponse.json(
      { error: "Account not found", isKnownError: true },
      { status: 404 },
    );
  }

  const { url: authUrl, state } = getAuthUrl({ userId, reconnectTarget });
  const parsedAuthUrl = new URL(authUrl);

  request.logger.info("Generated Microsoft email linking auth URL", {
    prompt: parsedAuthUrl.searchParams.get("prompt"),
    redirectUri: parsedAuthUrl.searchParams.get("redirect_uri"),
    requestedScopes: OUTLOOK_SCOPES,
  });

  const response = NextResponse.json({ url: authUrl });

  response.cookies.set(
    OUTLOOK_LINKING_STATE_COOKIE_NAME,
    state,
    oauthStateCookieOptions,
  );

  return response;
});
