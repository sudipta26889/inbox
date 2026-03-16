import { NextRequest, NextResponse } from "next/server";
import { withError } from "@/utils/middleware";
import {
  validateAccessToken,
  type McpTokenPayload,
} from "@/utils/mcp-server/tokens";
import {
  getAllTools,
  getTool,
  hasRequiredScope,
} from "@/utils/mcp-server/tools/registry";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import { auth } from "@/utils/auth";
import prisma from "@/utils/prisma";

const logger = createScopedLogger("mcp-server");

/**
 * MCP Server Protocol Handler
 *
 * This is the main endpoint that MCP clients (like Claude Desktop) will call.
 * It implements the Model Context Protocol JSON-RPC interface.
 *
 * Methods requiring authentication:
 * - tools/list: List all available tools
 * - tools/call: Execute a specific tool
 *
 * Methods without authentication (for discovery):
 * - initialize: Protocol handshake and capability negotiation
 * - ping: Health check
 *
 * Authentication: Bearer token (JWT) in Authorization header
 */

/**
 * POST /mcp-server - Handle MCP protocol requests
 */
export const POST = withError("mcp-server", async (request: NextRequest) => {
  const reqLogger = request.logger || logger;

  try {
    // Parse JSON-RPC message
    const message = await request.json();

    reqLogger.info("MCP request received", {
      method: message.method,
      id: message.id,
    });

    // Validate JSON-RPC format
    if (message.jsonrpc !== "2.0") {
      return createErrorResponse(
        message.id,
        -32600,
        "Invalid Request: jsonrpc must be '2.0'"
      );
    }

    if (!message.method || typeof message.method !== "string") {
      return createErrorResponse(
        message.id,
        -32600,
        "Invalid Request: missing or invalid method"
      );
    }

    // Authentication: Support BOTH Bearer tokens (OAuth) AND session cookies (browser-based)
    // This matches MeetEcho's pattern where it works seamlessly in Claude Desktop

    let userId: string;
    let emailAccountId: string;
    let clientId: string | undefined;
    let scopes: string[] = [];

    // Try Bearer token authentication first
    const authHeader = request.headers.get("Authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const jwtSecret = env.NEXTAUTH_SECRET;
      const tokenPayload = await validateAccessToken(token, jwtSecret);

      if (!tokenPayload) {
        reqLogger.warn("Invalid or expired access token");

        // Use Bearer scheme like MeetEcho
        const wwwAuth = `Bearer resource_metadata="${env.NEXT_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", ` +
          `error="invalid_token", ` +
          `error_description="Invalid or expired access token"`;

        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: "Unauthorized: Invalid or expired access token",
            },
          },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": wwwAuth,
            },
          }
        );
      }

      userId = tokenPayload.sub;
      emailAccountId = tokenPayload.email_account_id;
      clientId = tokenPayload.client_id;
      scopes = tokenPayload.scope ? tokenPayload.scope.split(" ") : [];

      reqLogger.info("Authenticated MCP request via Bearer token", {
        method: message.method,
        userId,
        clientId,
      });
    } else {
      // Try session-based authentication (for browser/Claude Desktop with cookies)
      const session = await auth();

      if (!session?.user?.id) {
        reqLogger.warn("No Bearer token or valid session found");

        // Return 401 with Bearer WWW-Authenticate header for OAuth discovery
        // MeetEcho uses Bearer, not MCP scheme
        const wwwAuth = `Bearer resource_metadata="${env.NEXT_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`;

        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: "Unauthorized: Missing Bearer token or session cookie",
            },
          },
          {
            status: 401,
            headers: {
              "WWW-Authenticate": wwwAuth,
            },
          }
        );
      }

      userId = session.user.id;

      // Get user's primary email account
      const primaryEmailAccount = await prisma.emailAccount.findFirst({
        where: {
          userId,
        },
        orderBy: {
          createdAt: "asc",
        },
      });

      if (!primaryEmailAccount) {
        reqLogger.warn("User has no email account", { userId });

        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32001,
              message: "User has no email account configured",
            },
          },
          { status: 401 }
        );
      }

      emailAccountId = primaryEmailAccount.id;

      // Session-based auth gets full access (all scopes)
      scopes = ["mcp:read", "mcp:write", "email:read", "email:write", "calendar:read", "stats:read", "rules:read", "rules:write"];

      reqLogger.info("Authenticated MCP request via session", {
        method: message.method,
        userId,
        emailAccountId,
      });
    }

    // Handle initialize method (REQUIRES AUTH like MeetEcho)
    if (message.method === "initialize") {
      reqLogger.info("MCP initialize request (authenticated)", {
        params: message.params,
        userId,
      });

      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {
              listChanged: false,
            },
          },
          serverInfo: {
            name: "Inbox MCP Server",
            version: "1.0.0",
          },
        },
      });
    }

    // Handle notifications/initialized (authenticated)
    if (message.method === "notifications/initialized") {
      reqLogger.info("MCP notifications/initialized", { userId });
      // Notifications don't need a response
      return new NextResponse(null, { status: 204 });
    }

    // Handle ping method
    if (message.method === "ping" || message.method === "notifications/ping") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          timestamp: new Date().toISOString(),
        },
      });
    }

    // Handle tools/list method
    if (message.method === "tools/list") {
      const tools = getAllTools();

      reqLogger.info("Listing MCP tools", {
        toolCount: tools.length,
        userId,
      });

      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools,
        },
      });
    }

    // Handle tools/call method
    if (message.method === "tools/call") {
      const toolName = message.params?.name;

      if (!toolName) {
        return createErrorResponse(
          message.id,
          -32602,
          "Invalid params: missing tool name"
        );
      }

      const tool = getTool(toolName);

      if (!tool) {
        return createErrorResponse(
          message.id,
          -32601,
          `Method not found: unknown tool '${toolName}'`
        );
      }

      // Check if user has required scope
      if (!hasRequiredScope(tool, scopes)) {
        reqLogger.warn("Insufficient scope for tool", {
          tool: toolName,
          requiredScope: tool.requiredScope,
          userScopes: scopes,
        });

        return createErrorResponse(
          message.id,
          -32003,
          `Insufficient permissions. Required scope: ${tool.requiredScope}`
        );
      }

      // Execute tool
      try {
        reqLogger.info("Executing MCP tool", {
          tool: toolName,
          userId,
          emailAccountId,
        });

        const result = await tool.handler(
          {
            userId,
            emailAccountId,
            clientId,
            scopes,
          },
          message.params?.arguments || {}
        );

        reqLogger.info("MCP tool executed successfully", {
          tool: toolName,
          userId,
        });

        return NextResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify(result, null, 2),
              },
            ],
          },
        });
      } catch (error: any) {
        reqLogger.error("MCP tool execution failed", {
          tool: toolName,
          error: error.message,
          stack: error.stack,
        });

        return createErrorResponse(
          message.id,
          -32603,
          `Tool execution failed: ${error.message || "Unknown error"}`
        );
      }
    }

    // Unknown method
    reqLogger.warn("Unknown MCP method", { method: message.method });
    return createErrorResponse(
      message.id,
      -32601,
      `Method not found: ${message.method}`
    );
  } catch (error: any) {
    reqLogger.error("MCP protocol error", {
      error: error.message,
      stack: error.stack,
    });

    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: "Parse error: " + (error.message || "Invalid JSON"),
        },
      },
      { status: 400 }
    );
  }
});

// Note: No GET endpoint - MeetEcho pattern
// Claude Desktop uses POST only for MCP JSON-RPC
// GET requests will return 404 (Next.js default)

/**
 * Helper: Create JSON-RPC error response
 */
function createErrorResponse(
  id: any,
  code: number,
  message: string
): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
      },
    },
    { status: code === -32700 ? 400 : 200 } // 400 for parse errors, 200 for application errors
  );
}
