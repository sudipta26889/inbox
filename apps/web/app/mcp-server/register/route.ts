import { NextRequest, NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import { generateSecureToken } from "@/utils/mcp-server/pkce";
import prisma from "@/utils/prisma";

/**
 * OAuth 2.0 Dynamic Client Registration
 * https://datatracker.ietf.org/doc/html/rfc7591
 *
 * This endpoint allows MCP clients to register dynamically without
 * pre-configuration. The client provides metadata (name, redirect URIs, etc.)
 * and receives a client_id.
 *
 * For public clients (like MCP clients), no client_secret is issued since
 * PKCE provides the security instead.
 */
export const POST = withError("mcp-server/register", async (request: NextRequest) => {
  const logger = request.logger;

  // Parse client metadata from request body
  const body = await request.json();

  const {
    client_name,
    redirect_uris,
    grant_types,
    response_types,
    token_endpoint_auth_method,
    scope,
    logo_uri,
    tos_uri,
    policy_uri,
  } = body;

  // Validate required fields
  if (!client_name || typeof client_name !== "string") {
    throw new SafeError("Missing or invalid required field: client_name");
  }

  if (!redirect_uris || !Array.isArray(redirect_uris) || redirect_uris.length === 0) {
    throw new SafeError(
      "Missing or invalid required field: redirect_uris (must be non-empty array)",
    );
  }

  // Validate redirect URIs
  for (const uri of redirect_uris) {
    try {
      const url = new URL(uri);
      // Allow https, http (for localhost), and custom URI schemes (like claude://)
      // Custom schemes are used by native apps like Claude Desktop
      const allowedProtocols = ["https:", "http:", "claude:"];
      const isLocalhost = ["localhost", "127.0.0.1"].includes(url.hostname);

      if (!allowedProtocols.includes(url.protocol) && !isLocalhost) {
        throw new SafeError(
          `Redirect URI must use HTTPS, HTTP (localhost only), or custom scheme (claude://): ${uri}`,
        );
      }

      // If using http (not custom scheme), must be localhost
      if (url.protocol === "http:" && !isLocalhost) {
        throw new SafeError(
          `HTTP redirect URIs only allowed for localhost: ${uri}`,
        );
      }
    } catch (error) {
      if (error instanceof SafeError) throw error;
      throw new SafeError(`Invalid redirect URI format: ${uri}`);
    }
  }

  // Validate grant types (default to authorization_code + refresh_token)
  const validGrantTypes = ["authorization_code", "refresh_token"];
  const clientGrantTypes = grant_types || ["authorization_code", "refresh_token"];

  for (const grantType of clientGrantTypes) {
    if (!validGrantTypes.includes(grantType)) {
      throw new SafeError(
        `Unsupported grant_type: ${grantType}. Supported: ${validGrantTypes.join(", ")}`,
      );
    }
  }

  // Validate response types (default to code)
  const validResponseTypes = ["code"];
  const clientResponseTypes = response_types || ["code"];

  for (const responseType of clientResponseTypes) {
    if (!validResponseTypes.includes(responseType)) {
      throw new SafeError(
        `Unsupported response_type: ${responseType}. Supported: ${validResponseTypes.join(", ")}`,
      );
    }
  }

  // Validate token endpoint auth method
  // For public clients (MCP), we only support "none" (PKCE provides security)
  const clientAuthMethod = token_endpoint_auth_method || "none";
  if (clientAuthMethod !== "none") {
    throw new SafeError(
      'Only token_endpoint_auth_method "none" is supported for MCP clients (use PKCE for security)',
    );
  }

  // Generate unique client_id
  const clientId = `mcp_${generateSecureToken(16)}`;

  // Create client in database
  const client = await prisma.mcpServerClient.create({
    data: {
      clientId,
      clientSecret: null, // Public client, no secret
      clientName: client_name,
      redirectUris: redirect_uris,
      grantTypes: clientGrantTypes,
      responseTypes: clientResponseTypes,
      tokenEndpointAuthMethod: clientAuthMethod,
      scope: scope || "",
      logoUri: logo_uri || null,
      tosUri: tos_uri || null,
      policyUri: policy_uri || null,
    },
  });

  logger.info("Registered new MCP client", {
    clientId,
    clientName: client_name,
    redirectUris: redirect_uris,
  });

  // Return client registration response (RFC 7591 format)
  return NextResponse.json(
    {
      client_id: client.clientId,
      client_secret: null, // Public client
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      scope: client.scope,
      logo_uri: client.logoUri,
      tos_uri: client.tosUri,
      policy_uri: client.policyUri,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
    },
    {
      status: 201,
      headers: {
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    },
  );
});
