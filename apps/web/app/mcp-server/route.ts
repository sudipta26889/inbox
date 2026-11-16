import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
import { validateAccessToken } from "@/utils/mcp-server/tokens";
import {
  getAllTools,
  getTool,
  hasRequiredScope,
} from "@/utils/mcp-server/tools/registry";
import { env } from "@/env";
import {
  BASE,
  LOOPBACK_HOSTS,
  MAX_TOOL_TEXT_CHARS,
  MCP_RESOURCE,
  MCP_SCOPES_SUPPORTED,
  PRM_URL,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@/utils/mcp-server/constants";
import { createScopedLogger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { accessibleEmailAccountWhere } from "@/utils/email-account-access";
import { buildMcpToolContext } from "@/utils/mcp-server/tool-context";
import { formatToolResponse } from "@/utils/mcp-server/format-response";
import {
  bodyTooLargeResponse,
  MCP_BODY_LIMIT,
  readJsonWithLimit,
} from "@/utils/request-body-limit";

const logger = createScopedLogger("mcp-server");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, MCP-Protocol-Version, Mcp-Session-Id",
  "Access-Control-Expose-Headers": "WWW-Authenticate",
};

/**
 * OPTIONS /mcp-server - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * GET /mcp-server - no SSE stream is offered; POST with JSON responses only
 */
export async function GET() {
  return new NextResponse(null, {
    status: 405,
    headers: { ...CORS_HEADERS, Allow: "POST, OPTIONS" },
  });
}

/**
 * POST /mcp-server - Handle MCP protocol requests
 */
export const POST = withError(
  "mcp-server",
  async (request: RequestWithLogger) => {
    const reqLogger = request.logger || logger;

    try {
      if (!isAllowedOrigin(request.headers.get("Origin"))) {
        reqLogger.warn("Rejected MCP request with disallowed Origin");
        return NextResponse.json(
          { detail: "Origin not allowed" },
          { status: 403, headers: CORS_HEADERS },
        );
      }

      const protocolVersion = request.headers.get("MCP-Protocol-Version");
      if (
        protocolVersion !== null &&
        !SUPPORTED_PROTOCOL_VERSIONS.includes(protocolVersion)
      ) {
        return NextResponse.json(
          { detail: `Unsupported MCP-Protocol-Version: ${protocolVersion}` },
          { status: 400, headers: CORS_HEADERS },
        );
      }

      const authHeader = request.headers.get("Authorization");
      if (!authHeader?.startsWith("Bearer ")) {
        reqLogger.warn("No Bearer token");
        return unauthorizedResponse("Authorization required");
      }

      const jwtSecret = env.AUTH_SECRET || env.NEXTAUTH_SECRET || "";
      const tokenPayload = await validateAccessToken(
        authHeader.substring(7),
        jwtSecret,
      );
      if (!tokenPayload) {
        reqLogger.warn("Invalid or expired access token");
        return unauthorizedResponse(
          "Invalid or expired access token",
          "invalid_token",
        );
      }

      if (!(await hasAcceptedAudience(tokenPayload))) {
        reqLogger.warn("Access token has wrong or missing audience", {
          clientId: tokenPayload.client_id,
        });
        return unauthorizedResponse(
          "Invalid or expired access token",
          "invalid_token",
        );
      }

      const userId = tokenPayload.sub;
      const emailAccountId = tokenPayload.email_account_id;
      const clientId = tokenPayload.client_id;
      const scopes = tokenPayload.scope ? tokenPayload.scope.split(" ") : [];

      reqLogger.info("Authenticated MCP request via Bearer token", {
        userId,
        clientId,
      });

      const body = await readJsonWithLimit(request, MCP_BODY_LIMIT);
      if (!body.ok) return createBodyErrorResponse(body.status);
      const message = body.value as any;

      reqLogger.info("MCP request received", {
        method: message.method,
        id: message.id,
      });

      if (message.jsonrpc !== "2.0") {
        return createErrorResponse(
          message.id,
          -32_600,
          "Invalid Request: jsonrpc must be '2.0'",
        );
      }

      if (!message.method || typeof message.method !== "string") {
        return createErrorResponse(
          message.id,
          -32_600,
          "Invalid Request: missing or invalid method",
        );
      }

      // Handle initialize
      if (message.method === "initialize") {
        // Fetch all email accounts for the user to provide context
        const emailAccounts = await prisma.emailAccount.findMany({
          where: accessibleEmailAccountWhere(userId),
          select: {
            id: true,
            email: true,
            account: {
              select: { provider: true },
            },
          },
          orderBy: { createdAt: "asc" },
        });

        const accountsList = emailAccounts
          .map((a) => `${a.email} (${a.account?.provider || "unknown"})`)
          .join(", ");
        const emailsList = emailAccounts.map((a) => a.email).join(", ");
        const instructions =
          emailAccounts.length > 0
            ? `IMPORTANT: You have access to ${emailAccounts.length} linked email account(s): ${accountsList}.\n\n` +
              "Email Searching:\n" +
              `- Use "list_email_accounts" to see all account IDs and details.\n` +
              `- "search_emails" searches across ALL accounts by default.\n` +
              `- To filter to one account, pass "emailAccountId" parameter.\n` +
              `- Results include "accountEmail" and "accountId" showing which account each email came from.\n\n` +
              "Writing Emails:\n" +
              `- Prefer "create_draft" over "send_email". It writes an unsent draft and returns a "webUrl" a person can open to review and send. Post that link when you report back.\n` +
              `- Use "send_email" only when the user has explicitly asked for the message to go out without review.\n` +
              `- Revise a draft with "update_draft" rather than creating a second one; "list_drafts" and "get_draft" show what a human has since edited or sent.\n` +
              `- For any write, you MUST specify the "from" parameter.\n` +
              `- The "from" value MUST be one of these EXACT email addresses: ${emailsList}\n` +
              `- Example: { "from": "${emailAccounts[0]?.email}", "to": ["user@example.com"], ... }\n` +
              `- If "from" doesn't match a configured account exactly, the write will fail.`
            : "No email accounts linked. Please connect an email account first.";

        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: negotiateProtocolVersion(
                message.params?.protocolVersion,
              ),
              capabilities: {
                tools: { listChanged: false },
              },
              serverInfo: {
                name: "Inbox MCP Server",
                version: "1.0.0",
              },
              instructions,
            },
          },
          { headers: CORS_HEADERS },
        );
      }

      // Handle notifications/initialized - return 202 Accepted per MCP spec
      if (message.method === "notifications/initialized") {
        return new NextResponse(null, { status: 202, headers: CORS_HEADERS });
      }

      // Handle ping
      if (
        message.method === "ping" ||
        message.method === "notifications/ping"
      ) {
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { timestamp: new Date().toISOString() },
          },
          { headers: CORS_HEADERS },
        );
      }

      // Handle tools/list
      if (message.method === "tools/list") {
        const tools = getAllTools(scopes);
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            result: { tools },
          },
          { headers: CORS_HEADERS },
        );
      }

      // Handle tools/call
      if (message.method === "tools/call") {
        const toolName = message.params?.name;
        if (!toolName) {
          return createErrorResponse(
            message.id,
            -32_602,
            "Invalid params: missing tool name",
          );
        }

        const tool = getTool(toolName);
        if (!tool) {
          return createErrorResponse(
            message.id,
            -32_601,
            `Method not found: unknown tool '${toolName}'`,
          );
        }

        if (!hasRequiredScope(tool, scopes)) {
          return NextResponse.json(
            {
              jsonrpc: "2.0",
              id: message.id,
              error: {
                code: -32_003,
                message: `Insufficient permissions. Required scope: ${tool.requiredScope}`,
              },
            },
            {
              status: 403,
              headers: {
                ...CORS_HEADERS,
                "WWW-Authenticate": `Bearer error="insufficient_scope", scope="${tool.requiredScope}", resource_metadata="${PRM_URL}"`,
              },
            },
          );
        }

        const toolContext = await buildMcpToolContext({
          userId,
          emailAccountId,
          clientId: clientId || "",
          scopes,
        });
        if (!toolContext) {
          return toolResultResponse(message.id, {
            content: [
              {
                type: "text",
                text: "Access to this email account has been revoked. Reconnect and pick another account.",
              },
            ],
            isError: true,
          });
        }

        try {
          const result = await tool.handler(
            toolContext,
            message.params?.arguments || {},
          );

          const formattedText = formatToolResponse(toolName, result);
          return toolResultResponse(
            message.id,
            buildToolResult(formattedText, result),
          );
        } catch (error: any) {
          reqLogger.error("MCP tool execution failed", {
            tool: toolName,
            error: error.message,
          });
          return toolResultResponse(message.id, {
            content: [
              {
                type: "text",
                text: `Tool execution failed: ${error.message || "Unknown error"}`,
              },
            ],
            isError: true,
          });
        }
      }

      return createErrorResponse(
        message.id,
        -32_601,
        `Method not found: ${message.method}`,
      );
    } catch (error: any) {
      reqLogger.error("MCP protocol error", { error: error.message });
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32_700,
            message: `Parse error: ${error.message || "Invalid JSON"}`,
          },
        },
        { status: 400, headers: CORS_HEADERS },
      );
    }
  },
);

// A token minted before `aud` existed is only trusted for A2A clients, whose
// static tokens can't refresh into one.
async function hasAcceptedAudience(tokenPayload: {
  aud?: string;
  client_id: string;
}): Promise<boolean> {
  if (tokenPayload.aud) return tokenPayload.aud === MCP_RESOURCE;
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId: tokenPayload.client_id },
    select: { type: true },
  });
  return client?.type === "A2A";
}

function negotiateProtocolVersion(requested: unknown): string {
  return typeof requested === "string" &&
    SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : SUPPORTED_PROTOCOL_VERSIONS[0];
}

function buildToolResult(text: string, result: unknown) {
  if (text.length > MAX_TOOL_TEXT_CHARS) {
    const omitted = text.length - MAX_TOOL_TEXT_CHARS;
    return {
      content: [
        {
          type: "text",
          text: `${text.slice(0, MAX_TOOL_TEXT_CHARS)}\n[truncated: ${omitted} chars omitted]`,
        },
      ],
    };
  }
  const isObject =
    typeof result === "object" && result !== null && !Array.isArray(result);
  return {
    content: [{ type: "text", text }],
    ...(isObject ? { structuredContent: result } : {}),
  };
}

function toolResultResponse(id: unknown, result: unknown) {
  return NextResponse.json(
    { jsonrpc: "2.0", id, result },
    { headers: CORS_HEADERS },
  );
}

function unauthorizedResponse(detail: string, error?: "invalid_token") {
  const challenge = [
    `resource_metadata="${PRM_URL}"`,
    `scope="${MCP_SCOPES_SUPPORTED.join(" ")}"`,
    ...(error ? [`error="${error}"`] : []),
  ].join(", ");
  return NextResponse.json(
    { detail },
    {
      status: 401,
      headers: { ...CORS_HEADERS, "WWW-Authenticate": `Bearer ${challenge}` },
    },
  );
}

// A missing Origin is a non-browser client; the literal "null" and anything
// unparseable are refused.
function isAllowedOrigin(origin: string | null): boolean {
  if (origin === null) return true;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === BASE) return true;
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.includes(url.hostname)
  );
}

function createErrorResponse(
  id: any,
  code: number,
  message: string,
): NextResponse {
  return NextResponse.json(
    { jsonrpc: "2.0", id, error: { code, message } },
    { status: code === -32_700 ? 400 : 200, headers: CORS_HEADERS },
  );
}

function createBodyErrorResponse(status: 400 | 413): Response {
  if (status === 413) {
    return bodyTooLargeResponse(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32_600, message: "Request body too large" },
      },
      CORS_HEADERS,
    );
  }

  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32_700, message: "Parse error: Invalid JSON" },
    },
    { status, headers: CORS_HEADERS },
  );
}
