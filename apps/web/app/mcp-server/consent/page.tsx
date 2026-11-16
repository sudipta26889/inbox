import { Card } from "@/components/ui/card";
import {
  redirectUriMatches,
  validateRedirectUri,
} from "@/utils/mcp-server/redirect-uri";
import prisma from "@/utils/prisma";
import ConsentContent from "./consent-content";

/**
 * OAuth 2.1 Consent Screen Page
 *
 * Shows what an MCP client is requesting and lets the user approve or deny.
 * The client's name, logo and redirect host come from the database, never from
 * URL parameters, so a crafted link can't make a client look like another.
 */
export default async function McpConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = readParams(await searchParams);
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");

  const client = clientId
    ? await prisma.mcpServerClient.findUnique({ where: { clientId } })
    : null;

  if (!client || !redirectUri || !isRegisteredRedirect(redirectUri, client)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
        <Card className="max-w-md w-full p-6 space-y-2 text-center">
          <h1 className="text-xl font-bold">Cannot authorize</h1>
          <p className="text-gray-600">
            This authorization request is invalid. Return to the application and
            try connecting again.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <ConsentContent
      clientName={client.clientName}
      logoUri={client.logoUri}
      redirectHost={new URL(redirectUri).host}
      request={{
        client_id: client.clientId,
        redirect_uri: redirectUri,
        scope: params.get("scope") || "",
        state: params.get("state") || "",
        code_challenge: params.get("code_challenge") || "",
        code_challenge_method: params.get("code_challenge_method") || "S256",
        email_account_id: params.get("email_account_id") || "",
      }}
    />
  );
}

function readParams(raw: Record<string, string | string[] | undefined>) {
  const oauthState = first(raw.oauth_state);
  if (oauthState) {
    try {
      return new URLSearchParams(
        Buffer.from(oauthState, "base64url").toString("utf-8"),
      );
    } catch {
      return new URLSearchParams();
    }
  }
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    const single = first(value);
    if (single !== undefined) params.set(key, single);
  }
  return params;
}

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function isRegisteredRedirect(
  redirectUri: string,
  client: { redirectUris: string[] },
) {
  try {
    validateRedirectUri(redirectUri);
  } catch {
    return false;
  }
  return redirectUriMatches(redirectUri, client.redirectUris);
}
