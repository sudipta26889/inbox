/**
 * Shared constants for MCP server that can be used in both client and server code
 */

/**
 * Supported OAuth scopes for MCP server
 */
export const MCP_SCOPES = {
  "email:read": "Read email data",
  "email:draft": "Create and edit unsent drafts (cannot send)",
  "email:write": "Send and manage emails",
  "calendar:read": "Read calendar data",
  "calendar:write": "Create and manage calendar events",
  "stats:read": "Read analytics and statistics",
  "rules:read": "Read automation rules",
  "rules:write": "Create and modify automation rules",
  "admin:read":
    "Read inbox settings: rules, categories, groups, knowledge, cold-email blocker, reply tracker, follow-ups, digest, AI model, account, cleanup jobs, unsubscribe candidates.",
  "admin:write":
    "Create, modify and delete inbox settings: rules, categories, groups, knowledge, cold-email blocker, reply tracker, follow-ups, digest, AI model, account settings, cleanup jobs, unsubscribe requests. Excludes API keys, webhooks, and MCP client registration.",
  // Legacy scopes: still accepted so existing clients keep authorizing, but not
  // advertised, so new clients discover the granular ones instead.
  admin:
    "Full inbox settings access (legacy — prefer admin:read / admin:write)",
  "mcp:read": "Legacy no-op — gates no tool",
  "mcp:write": "Legacy no-op — gates no tool",
} as const;

/**
 * Accepted for backward compatibility but deliberately kept out of discovery.
 * `admin` is an omnibus grant over 46 tools; advertising it invites clients to
 * request everything in one prompt instead of the read/write split.
 * `mcp:read`/`mcp:write` gate no tool at all and never have.
 */
const LEGACY_SCOPES = new Set(["admin", "mcp:read", "mcp:write"]);

export type McpScope = keyof typeof MCP_SCOPES;

/**
 * Scopes advertised by OAuth discovery. Derived so the four `.well-known`
 * routes can't drift from what the server actually enforces — a scope missing
 * here is one no discovering client will ever request.
 */
export const MCP_SCOPES_SUPPORTED = Object.keys(MCP_SCOPES).filter(
  (scope) => !LEGACY_SCOPES.has(scope),
);

/**
 * Token configuration
 */
export const TOKEN_CONFIG = {
  ACCESS_TOKEN_TTL: 60 * 60, // 1 hour in seconds
  REFRESH_TOKEN_TTL: 60 * 60 * 24 * 30, // 30 days in seconds
  AUTHORIZATION_CODE_TTL: 60 * 10, // 10 minutes in seconds
} as const;
