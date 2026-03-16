import { NextResponse } from "next/server";
import { env } from "@/env";

/**
 * RFC 9728: OAuth 2.0 Protected Resource Metadata
 * https://datatracker.ietf.org/doc/html/rfc9728
 *
 * This endpoint allows MCP clients to discover the authorization servers
 * protecting this resource and the authentication requirements.
 *
 * MCP clients will probe this endpoint when connecting to the server URL.
 */
export async function GET() {
  const baseUrl = env.NEXT_PUBLIC_BASE_URL;

  const metadata = {
    // The resource server identifier
    resource: baseUrl,

    // Authorization servers that protect this resource
    // MCP clients will use these URLs to discover OAuth endpoints
    authorization_servers: [baseUrl],

    // Supported bearer token methods (header, query, body)
    // We only support Authorization header for security
    bearer_methods_supported: ["header"],

    // Optional: Resource documentation URL
    resource_documentation: `${baseUrl}/docs`,

    // Optional: Scopes required to access this resource
    scopes_supported: [
      "mcp:read", // Read-only access to MCP tools (search, get)
      "mcp:write", // Write access to MCP tools (send, create, update)
      "email:read", // Read email data
      "email:write", // Send and manage emails
      "calendar:read", // Read calendar data
      "stats:read", // Read analytics and statistics
      "rules:read", // Read automation rules
      "rules:write", // Create and modify automation rules
    ],

    // Token types supported (default is Bearer)
    token_types_supported: ["Bearer"],
  };

  return NextResponse.json(metadata, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600", // Cache for 1 hour
    },
  });
}
