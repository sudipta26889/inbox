import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { env } from "@/env";

/**
 * Middleware to handle OAuth 2.1 discovery endpoints for MCP server
 *
 * Next.js app router doesn't handle `.well-known` directories well,
 * so we intercept these requests in middleware and return the JSON responses directly.
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // RFC 9728: OAuth 2.0 Protected Resource Metadata
  if (pathname === "/.well-known/oauth-protected-resource") {
    const baseUrl = env.NEXT_PUBLIC_BASE_URL;

    const metadata = {
      resource: `${baseUrl}/mcp-server`,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      resource_documentation: `${baseUrl}/docs`,
      resource_type: "mcp-server",
      mcp_protocol_version: "2024-11-05",
      scopes_supported: [
        "mcp:read",
        "mcp:write",
        "email:read",
        "email:write",
        "calendar:read",
        "stats:read",
        "rules:read",
        "rules:write",
      ],
      token_types_supported: ["Bearer"],
    };

    return NextResponse.json(metadata, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // RFC 8414: OAuth 2.0 Authorization Server Metadata
  if (pathname === "/.well-known/oauth-authorization-server") {
    const baseUrl = env.NEXT_PUBLIC_BASE_URL;

    const metadata = {
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/mcp-server/authorize`,
      token_endpoint: `${baseUrl}/mcp-server/token`,
      registration_endpoint: `${baseUrl}/mcp-server/register`,
      revocation_endpoint: `${baseUrl}/mcp-server/revoke`,
      scopes_supported: [
        "mcp:read",
        "mcp:write",
        "email:read",
        "email:write",
        "calendar:read",
        "stats:read",
        "rules:read",
        "rules:write",
      ],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: [
        "none",
        "client_secret_post",
      ],
      code_challenge_methods_supported: ["S256", "plain"],
      token_types_supported: ["Bearer"],
      // RFC 8707: Resource Indicators for OAuth 2.0 (required by MCP spec)
      resource_indicators_supported: true,
      service_documentation: `${baseUrl}/docs/mcp`,
      ui_locales_supported: ["en"],
      claims_supported: [
        "sub",
        "email",
        "email_account_id",
        "scope",
        "client_id",
        "exp",
        "iat",
        "jti",
      ],
      require_pushed_authorization_requests: false,
      require_request_uri_registration: false,
      require_pkce: true,
    };

    return NextResponse.json(metadata, {
      status: 200,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=3600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  // Continue with normal request handling
  return NextResponse.next();
}

/**
 * Configure which routes this middleware should run on
 *
 * Match only the .well-known paths to avoid performance overhead
 * on other routes
 */
export const config = {
  matcher: ["/.well-known/:path*"],
};
