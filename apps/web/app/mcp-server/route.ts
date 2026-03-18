import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
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
import { formatToolResponse } from "@/utils/mcp-server/format-response";

const logger = createScopedLogger("mcp-server");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

/**
 * OPTIONS /mcp-server - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /mcp-server - Handle MCP protocol requests
 */
export const POST = withError("mcp-server", async (request: RequestWithLogger) => {
  const reqLogger = request.logger || logger;

  try {
    const message = await request.json();

    reqLogger.info("MCP request received", {
      method: message.method,
      id: message.id,
    });

    if (message.jsonrpc !== "2.0") {
      return createErrorResponse(message.id, -32600, "Invalid Request: jsonrpc must be '2.0'");
    }

    if (!message.method || typeof message.method !== "string") {
      return createErrorResponse(message.id, -32600, "Invalid Request: missing or invalid method");
    }

    let userId: string | undefined;
    let emailAccountId: string | undefined;
    let clientId: string | undefined;
    let scopes: string[] = [];

    // Try Bearer token authentication first
    const authHeader = request.headers.get("Authorization");

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7);
      const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";
      const tokenPayload = await validateAccessToken(token, jwtSecret);

      if (!tokenPayload) {
        reqLogger.warn("Invalid or expired access token");
        return NextResponse.json(
          { detail: "Invalid or expired access token" },
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "WWW-Authenticate": `Bearer resource_metadata="${env.NEXT_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource", error="invalid_token"`,
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
      // Try session-based authentication
      const session = await auth();

      if (!session?.user?.id) {
        reqLogger.warn("No Bearer token or valid session found");
        return NextResponse.json(
          { detail: "Authorization required" },
          {
            status: 401,
            headers: {
              ...CORS_HEADERS,
              "WWW-Authenticate": `Bearer resource_metadata="${env.NEXT_PUBLIC_BASE_URL}/.well-known/oauth-protected-resource"`,
            },
          }
        );
      }

      userId = session.user.id;

      const primaryEmailAccount = await prisma.emailAccount.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      });

      if (!primaryEmailAccount) {
        reqLogger.warn("User has no email account", { userId });
        return NextResponse.json(
          { detail: "User has no email account configured" },
          { status: 400, headers: CORS_HEADERS }
        );
      }

      emailAccountId = primaryEmailAccount.id;
      scopes = ["mcp:read", "mcp:write", "email:read", "email:write", "calendar:read", "calendar:write", "stats:read", "rules:read", "rules:write"];

      reqLogger.info("Authenticated MCP request via session", {
        method: message.method,
        userId,
        emailAccountId,
      });
    }

    // Handle initialize
    if (message.method === "initialize") {
      // Fetch all email accounts for the user to provide context
      const emailAccounts = userId ? await prisma.emailAccount.findMany({
        where: { userId },
        select: {
          id: true,
          email: true,
          account: {
            select: { provider: true },
          },
        },
        orderBy: { createdAt: "asc" },
      }) : [];

      const accountsList = emailAccounts.map(a => `${a.email} (${a.account?.provider || 'unknown'})`).join(", ");
      const emailsList = emailAccounts.map(a => a.email).join(", ");
      const instructions = emailAccounts.length > 0
        ? `IMPORTANT: You have access to ${emailAccounts.length} linked email account(s): ${accountsList}.\n\n` +
          `Email Searching:\n` +
          `- Use "list_email_accounts" to see all account IDs and details.\n` +
          `- "search_emails" searches across ALL accounts by default.\n` +
          `- To filter to one account, pass "emailAccountId" parameter.\n` +
          `- Results include "accountEmail" and "accountId" showing which account each email came from.\n\n` +
          `Sending Emails:\n` +
          `- When sending with "send_email", you MUST specify the "from" parameter.\n` +
          `- The "from" value MUST be one of these EXACT email addresses: ${emailsList}\n` +
          `- Example: { "from": "${emailAccounts[0]?.email}", "to": ["user@example.com"], ... }\n` +
          `- If "from" doesn't match a configured account exactly, the send will fail.`
        : "No email accounts linked. Please connect an email account first.";

      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: { listChanged: false },
          },
          serverInfo: {
            name: "Inbox MCP Server",
            version: "1.0.0",
            instructions,
          },
        },
      }, { headers: CORS_HEADERS });
    }

    // Handle notifications/initialized - return 202 Accepted per MCP spec
    if (message.method === "notifications/initialized") {
      return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
    }

    // Handle ping
    if (message.method === "ping" || message.method === "notifications/ping") {
      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { timestamp: new Date().toISOString() },
      }, { headers: CORS_HEADERS });
    }

    // Handle tools/list
    if (message.method === "tools/list") {
      const tools = getAllTools();
      return NextResponse.json({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools },
      }, { headers: CORS_HEADERS });
    }

    // Handle tools/call
    if (message.method === "tools/call") {
      const toolName = message.params?.name;
      if (!toolName) {
        return createErrorResponse(message.id, -32602, "Invalid params: missing tool name");
      }

      const tool = getTool(toolName);
      if (!tool) {
        return createErrorResponse(message.id, -32601, `Method not found: unknown tool '${toolName}'`);
      }

      if (!hasRequiredScope(tool, scopes)) {
        return createErrorResponse(message.id, -32003, `Insufficient permissions. Required scope: ${tool.requiredScope}`);
      }

      // At this point, authentication has succeeded so these must be defined
      if (!userId || !emailAccountId) {
        return createErrorResponse(message.id, -32603, "Internal error: missing user context");
      }

      try {
        const result = await tool.handler(
          {
            userId,
            emailAccountId,
            clientId: clientId || "",
            scopes
          },
          message.params?.arguments || {}
        );

        // Format response as Markdown for better readability
        const formattedText = formatToolResponse(toolName, result);

        return NextResponse.json({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [{ type: "text", text: formattedText }],
          },
        }, { headers: CORS_HEADERS });
      } catch (error: any) {
        reqLogger.error("MCP tool execution failed", { tool: toolName, error: error.message });
        return createErrorResponse(message.id, -32603, `Tool execution failed: ${error.message || "Unknown error"}`);
      }
    }

    return createErrorResponse(message.id, -32601, `Method not found: ${message.method}`);
  } catch (error: any) {
    reqLogger.error("MCP protocol error", { error: error.message });
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error: " + (error.message || "Invalid JSON") } },
      { status: 400, headers: CORS_HEADERS }
    );
  }
});

function createErrorResponse(id: any, code: number, message: string): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: code === -32700 ? 400 : 200, headers: CORS_HEADERS }
  );
}
