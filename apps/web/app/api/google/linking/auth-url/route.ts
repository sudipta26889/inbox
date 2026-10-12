import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getLinkingOAuth2Client } from "@/utils/gmail/client";
import { GOOGLE_LINKING_STATE_COOKIE_NAME } from "@/utils/gmail/constants";
import { SCOPES } from "@/utils/gmail/scopes";
import { findReconnectTarget } from "@/utils/oauth/reconnect-target";
import {
  generateOAuthState,
  oauthStateCookieOptions,
} from "@/utils/oauth/state";

export type GetAuthLinkUrlResponse = { url: string };

const getAuthUrl = ({
  userId,
  reconnectTarget,
}: {
  userId: string;
  reconnectTarget: { id: string; email: string } | null;
}) => {
  const googleAuth = getLinkingOAuth2Client();

  // The state lives in an httpOnly cookie the callback compares against, so
  // the reconnect target carried in it can't be swapped by the client.
  const state = generateOAuthState({
    userId,
    ...(reconnectTarget && { reconnectEmailAccountId: reconnectTarget.id }),
  });

  const url = googleAuth.generateAuthUrl({
    access_type: "offline",
    scope: [...new Set([...SCOPES, "openid", "email"])].join(" "),
    prompt: "consent",
    state,
    // Reconnects target one mailbox, so point Google at it rather than letting
    // whichever account the browser is already signed into decide.
    ...(reconnectTarget && { login_hint: reconnectTarget.email }),
  });

  return { url, state };
};

export const GET = withAuth("google/linking/auth-url", async (request) => {
  const userId = request.auth.userId;
  // Not request.nextUrl: withAuth hands over a cloned request without it.
  const reconnectEmailAccountId = new URL(request.url).searchParams.get(
    "emailAccountId",
  );
  const reconnectTarget = reconnectEmailAccountId
    ? await findReconnectTarget({
        emailAccountId: reconnectEmailAccountId,
        userId,
        provider: "google",
      })
    : null;

  // Falling back to an unconstrained link would reconnect whichever mailbox the
  // browser is signed into, which is the outcome the target exists to prevent.
  if (reconnectEmailAccountId && !reconnectTarget) {
    return NextResponse.json(
      { error: "Account not found", isKnownError: true },
      { status: 404 },
    );
  }

  const { url: authUrl, state } = getAuthUrl({ userId, reconnectTarget });

  const response = NextResponse.json({ url: authUrl });

  response.cookies.set(
    GOOGLE_LINKING_STATE_COOKIE_NAME,
    state,
    oauthStateCookieOptions,
  );

  return response;
});
