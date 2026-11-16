import { NextResponse } from "next/server";
import {
  BASE,
  MCP_RESOURCE,
  MCP_SCOPES_SUPPORTED,
} from "@/utils/mcp-server/constants";

// Served from proxy.ts: the app router does not route `.well-known` reliably,
// and upstream's own `/.well-known/oauth-*` route files (behind
// MCP_SERVER_ENABLED) must never answer for the fork's /mcp-server.
export function discoveryResponse(pathname: string): NextResponse | null {
  // RFC 9728: OAuth 2.0 Protected Resource Metadata
  if (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp-server"
  ) {
    return json({
      resource: MCP_RESOURCE,
      authorization_servers: [BASE],
      bearer_methods_supported: ["header"],
      resource_documentation: `${BASE}/docs`,
      resource_type: "mcp-server",
      scopes_supported: MCP_SCOPES_SUPPORTED,
      token_types_supported: ["Bearer"],
    });
  }

  // RFC 8414: OAuth 2.0 Authorization Server Metadata
  if (pathname === "/.well-known/oauth-authorization-server") {
    return json({
      issuer: BASE,
      authorization_endpoint: `${BASE}/mcp-server/authorize`,
      token_endpoint: `${BASE}/mcp-server/token`,
      registration_endpoint: `${BASE}/mcp-server/register`,
      revocation_endpoint: `${BASE}/mcp-server/revoke`,
      scopes_supported: MCP_SCOPES_SUPPORTED,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      token_types_supported: ["Bearer"],
      // RFC 8707: Resource Indicators for OAuth 2.0 (required by MCP spec)
      resource_indicators_supported: true,
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      service_documentation: `${BASE}/docs/mcp`,
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
    });
  }

  return null;
}

function json(metadata: Record<string, unknown>) {
  return NextResponse.json(metadata, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
