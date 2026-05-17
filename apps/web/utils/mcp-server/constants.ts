/**
 * Shared constants for MCP server that can be used in both client and server code
 */

/**
 * Supported OAuth scopes for MCP server
 */
export const MCP_SCOPES = {
  "mcp:read": "Read-only access to MCP tools",
  "mcp:write": "Read-write access to MCP tools",
  "email:read": "Read email data",
  "email:write": "Send and manage emails",
  "calendar:read": "Read calendar data",
  "calendar:write": "Create and manage calendar events",
  "stats:read": "Read analytics and statistics",
  "rules:read": "Read automation rules",
  "rules:write": "Create and modify automation rules",
  admin:
    "Read and write all inbox settings: rules, categories, knowledge, cold-email blocker, reply tracker, follow-ups, digest, AI model, account settings, cleanup, unsubscribe. Excludes API keys, webhooks, and MCP client registration.",
} as const;

export type McpScope = keyof typeof MCP_SCOPES;

/**
 * Token configuration
 */
export const TOKEN_CONFIG = {
  ACCESS_TOKEN_TTL: 60 * 60, // 1 hour in seconds
  REFRESH_TOKEN_TTL: 60 * 60 * 24 * 30, // 30 days in seconds
  AUTHORIZATION_CODE_TTL: 60 * 10, // 10 minutes in seconds
} as const;
