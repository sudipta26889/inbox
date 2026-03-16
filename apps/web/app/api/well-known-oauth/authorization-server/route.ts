import { NextResponse } from "next/server";
import { env } from "@/env";

/**
 * RFC 8414: OAuth 2.0 Authorization Server Metadata
 * https://datatracker.ietf.org/doc/html/rfc8414
 *
 * This endpoint provides OAuth 2.1 authorization server metadata for MCP clients.
 * It allows clients to discover:
 * - Authorization endpoint (where users authenticate)
 * - Token endpoint (where clients exchange codes for tokens)
 * - Registration endpoint (for dynamic client registration)
 * - Supported features (PKCE, scopes, grant types, etc.)
 *
 * MCP clients will discover this endpoint via the /.well-known/oauth-protected-resource
 * response, then fetch this metadata to learn how to authenticate.
 */
export async function GET() {
  const baseUrl = env.NEXT_PUBLIC_BASE_URL;

  const metadata = {
    // Issuer identifier - must match the URL this is served from
    issuer: baseUrl,

    // OAuth 2.1 endpoints
    authorization_endpoint: `${baseUrl}/mcp-server/authorize`,
    token_endpoint: `${baseUrl}/mcp-server/token`,
    registration_endpoint: `${baseUrl}/mcp-server/register`,

    // Optional: Token revocation endpoint (RFC 7009)
    revocation_endpoint: `${baseUrl}/mcp-server/revoke`,

    // Scopes supported by this authorization server
    scopes_supported: [
      "mcp:read", // Read-only MCP access
      "mcp:write", // Read-write MCP access
      "email:read", // Read email data
      "email:write", // Send and manage emails
      "calendar:read", // Read calendar data
      "stats:read", // Read analytics
      "rules:read", // Read automation rules
      "rules:write", // Modify automation rules
    ],

    // Response types supported (OAuth 2.1 uses "code" for authorization code flow)
    response_types_supported: ["code"],

    // Grant types supported
    grant_types_supported: [
      "authorization_code", // Standard OAuth flow
      "refresh_token", // Token refresh
    ],

    // Token endpoint authentication methods
    // "none" means public clients (like MCP clients) don't need client secrets
    // PKCE provides security instead
    token_endpoint_auth_methods_supported: [
      "none", // Public clients with PKCE
      "client_secret_post", // Optional: for confidential clients
    ],

    // PKCE challenge methods (OAuth 2.1 requires S256)
    code_challenge_methods_supported: [
      "S256", // SHA-256 hash (mandatory in OAuth 2.1)
      "plain", // Plain text (discouraged, only for testing)
    ],

    // Token types issued
    token_types_supported: ["Bearer"],

    // Service documentation
    service_documentation: `${baseUrl}/docs/mcp`,

    // UI locales supported
    ui_locales_supported: ["en"],

    // Claims supported (if using JWT tokens)
    claims_supported: [
      "sub", // Subject (user ID)
      "email", // User email
      "email_account_id", // Email account ID
      "scope", // Granted scopes
      "client_id", // Client ID
      "exp", // Expiration time
      "iat", // Issued at time
      "jti", // JWT ID
    ],

    // OAuth 2.1 features
    require_pushed_authorization_requests: false, // PAR not required (but supported)
    require_request_uri_registration: false,

    // PKCE is mandatory for all clients
    require_pkce: true,
  };

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    },
  });
}
