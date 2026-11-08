import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
import { SafeError } from "@/utils/error";
import {
  checkIpRateLimit,
  createRateLimitResponse,
  getClientIp,
} from "@/utils/a2a/rate-limit";
import { generateSecureToken } from "@/utils/mcp-server/pkce";
import prisma from "@/utils/prisma";
import {
  bodyTooLargeResponse,
  MCP_PUBLIC_FORM_LIMIT,
  readJsonWithLimit,
} from "@/utils/request-body-limit";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * OPTIONS /mcp-server/register - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * OAuth 2.0 Dynamic Client Registration (RFC 7591)
 */
export const POST = withError(
  "mcp-server/register",
  async (request: RequestWithLogger) => {
    const logger = request.logger;

    const rateLimit = await checkIpRateLimit(getClientIp(request));
    if (!rateLimit.allowed) {
      const { status, headers, body } = createRateLimitResponse(rateLimit);
      return NextResponse.json(body, {
        status,
        headers: { ...CORS_HEADERS, ...headers },
      });
    }

    const parsed = await readJsonWithLimit(request, MCP_PUBLIC_FORM_LIMIT);
    if (!parsed.ok) {
      if (parsed.status === 413) {
        return bodyTooLargeResponse(
          {
            error: "invalid_client_metadata",
            error_description: "Request body too large",
          },
          CORS_HEADERS,
        );
      }
      return NextResponse.json(
        { error: "invalid_client_metadata", error_description: "Invalid JSON" },
        { status: parsed.status, headers: CORS_HEADERS },
      );
    }

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
    } = parsed.value as any;

    // client_name is OPTIONAL per RFC 7591
    const resolvedClientName =
      (typeof client_name === "string" && client_name) || "MCP Client";

    if (
      !redirect_uris ||
      !Array.isArray(redirect_uris) ||
      redirect_uris.length === 0
    ) {
      throw new SafeError(
        "Missing or invalid required field: redirect_uris (must be non-empty array)",
      );
    }

    // Validate redirect URIs - allow any valid URL scheme
    for (const uri of redirect_uris) {
      try {
        new URL(uri);
      } catch (error) {
        if (error instanceof SafeError) throw error;
        throw new SafeError(`Invalid redirect URI format: ${uri}`);
      }
    }

    const validGrantTypes = ["authorization_code", "refresh_token"];
    const clientGrantTypes = grant_types || [
      "authorization_code",
      "refresh_token",
    ];
    for (const grantType of clientGrantTypes) {
      if (!validGrantTypes.includes(grantType)) {
        throw new SafeError(`Unsupported grant_type: ${grantType}`);
      }
    }

    const clientResponseTypes = response_types || ["code"];
    const clientAuthMethod = token_endpoint_auth_method || "none";

    const clientId = `mcp_${generateSecureToken(16)}`;

    const client = await prisma.mcpServerClient.create({
      data: {
        clientId,
        clientSecret: null,
        clientName: resolvedClientName,
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
      clientName: resolvedClientName,
      redirectUris: redirect_uris,
    });

    // RFC 7591: omit client_secret for public clients (don't send null)
    const response: Record<string, unknown> = {
      client_id: client.clientId,
      client_id_issued_at: Math.floor(client.createdAt.getTime() / 1000),
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      response_types: client.responseTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    };

    if (resolvedClientName !== "MCP Client") {
      response.client_name = resolvedClientName;
    }

    return NextResponse.json(response, {
      status: 201,
      headers: {
        ...CORS_HEADERS,
        "Cache-Control": "no-store",
        Pragma: "no-cache",
      },
    });
  },
);
