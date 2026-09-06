import { NextResponse } from "next/server";
import { withError, type RequestWithLogger } from "@/utils/middleware";
import { createScopedLogger } from "@/utils/logger";
import {
  authenticateA2aRequest,
  createUnauthorizedResponse,
} from "@/utils/a2a/auth";
import {
  checkA2aRequestRateLimit,
  checkIpRateLimit,
  createRateLimitResponse,
  getClientIp,
  getRateLimitHeaders,
} from "@/utils/a2a/rate-limit";
import {
  normalizeA2aMethod,
  normalizeMessageSendParams,
} from "@/utils/a2a/interop";
import {
  handleMessageSend,
  handleTaskGet,
  handleTaskList,
  handleTaskCancel,
  handleContextGet,
} from "@/utils/a2a/protocol-handler";
import { env } from "@/env";

const logger = createScopedLogger("a2a");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Expose-Headers":
    "WWW-Authenticate, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After",
};

/**
 * OPTIONS /a2a - CORS preflight
 */
export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * POST /a2a - A2A Protocol JSON-RPC 2.0 endpoint
 *
 * Implements the A2A Protocol v0.3 JSON-RPC binding
 * Spec: https://github.com/google/a2a
 */
export const POST = withError("a2a", async (request: RequestWithLogger) => {
  const reqLogger = request.logger || logger;

  try {
    // Parse JSON-RPC request
    const message = await request.json();

    reqLogger.info("A2A request received", {
      method: message.method,
      id: message.id,
    });

    // Validate JSON-RPC 2.0 format
    if (message.jsonrpc !== "2.0") {
      return createJsonRpcErrorResponse(
        message.id,
        -32_600,
        "Invalid Request: jsonrpc must be '2.0'",
      );
    }

    if (!message.method || typeof message.method !== "string") {
      return createJsonRpcErrorResponse(
        message.id,
        -32_600,
        "Invalid Request: missing or invalid method",
      );
    }

    // Try to authenticate request
    const authHeader = request.headers.get("Authorization");
    const authContext = authHeader
      ? await authenticateA2aRequest(authHeader)
      : null;

    // For unauthenticated requests, apply IP-based rate limiting
    if (!authContext) {
      const clientIp = getClientIp(request);
      const ipRateLimitResult = await checkIpRateLimit(clientIp);

      if (!ipRateLimitResult.allowed) {
        const rateLimitResponse = createRateLimitResponse(ipRateLimitResult);
        return NextResponse.json(
          {
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32_003,
              message: rateLimitResponse.body.error_description,
              data: rateLimitResponse.body,
            },
          },
          {
            status: rateLimitResponse.status,
            headers: {
              ...CORS_HEADERS,
              ...rateLimitResponse.headers,
            },
          },
        );
      }
    }

    // Handle initialize (no authentication required for discovery)
    if (message.method === "initialize") {
      reqLogger.info("A2A initialize request");

      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "0.3",
            serverInfo: {
              name: "Inbox A2A Agent",
              version: "1.0.0",
              description:
                "AI-powered email and calendar automation with multi-account support",
              agentCard: `${env.NEXT_PUBLIC_BASE_URL}/.well-known/agent-card.json`,
            },
            capabilities: {
              streaming: false,
              pushNotifications: false,
              humanInTheLoop: true,
              stateTransitionHistory: true,
            },
          },
        },
        { headers: CORS_HEADERS },
      );
    }

    // All other methods require authentication
    if (!authContext) {
      reqLogger.warn("Unauthenticated request to protected method", {
        method: message.method,
      });

      const unauthorizedResponse = createUnauthorizedResponse();
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32_002,
            message: "Authentication required",
            data: unauthorizedResponse.body,
          },
        },
        {
          status: unauthorizedResponse.status,
          headers: {
            ...CORS_HEADERS,
            ...unauthorizedResponse.headers,
          },
        },
      );
    }

    // One spelling in, one canonical name out — see utils/a2a/interop.ts.
    const canonicalMethod = normalizeA2aMethod(message.method);

    // Check rate limits for authenticated requests
    const operation =
      canonicalMethod === "message.send" ? "task_create" : "request";
    const rateLimitResult = await checkA2aRequestRateLimit(
      authContext,
      operation,
    );

    if (!rateLimitResult.allowed) {
      const rateLimitResponse = createRateLimitResponse(rateLimitResult);
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          error: {
            code: -32_003,
            message: rateLimitResponse.body.error_description,
            data: rateLimitResponse.body,
          },
        },
        {
          status: rateLimitResponse.status,
          headers: {
            ...CORS_HEADERS,
            ...rateLimitResponse.headers,
          },
        },
      );
    }

    reqLogger.info("Authenticated A2A request", {
      method: message.method,
      userId: authContext.userId,
      clientId: authContext.clientId,
    });

    // Route to protocol handlers
    const rateLimitHeaders = getRateLimitHeaders(rateLimitResult);

    try {
      let result: unknown;

      switch (canonicalMethod) {
        case "message.send":
          result = await handleMessageSend(
            authContext,
            normalizeMessageSendParams(message.params || {}),
          );
          break;

        case "task.get":
          result = await handleTaskGet(authContext, message.params || {});
          break;

        case "task.list":
          result = await handleTaskList(authContext, message.params || {});
          break;

        case "task.cancel":
          result = await handleTaskCancel(authContext, message.params || {});
          break;

        case "context.get":
          result = await handleContextGet(authContext, message.params || {});
          break;

        default:
          return createJsonRpcErrorResponse(
            message.id,
            -32_601,
            `Method not found: ${message.method}`,
          );
      }

      // Return success response
      return NextResponse.json(
        {
          jsonrpc: "2.0",
          id: message.id,
          result,
        },
        {
          headers: {
            ...CORS_HEADERS,
            ...rateLimitHeaders,
          },
        },
      );
    } catch (handlerError) {
      reqLogger.error("A2A handler error", {
        method: message.method,
        error: handlerError,
      });

      return createJsonRpcErrorResponse(
        message.id,
        -32_603,
        `Handler error: ${handlerError instanceof Error ? handlerError.message : String(handlerError)}`,
      );
    }
  } catch (error) {
    reqLogger.error("A2A protocol error", { error });

    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32_700,
          message:
            "Parse error: " +
            ((error instanceof Error ? error.message : String(error)) ||
              "Invalid JSON"),
        },
      },
      { status: 400, headers: CORS_HEADERS },
    );
  }
});

/**
 * Helper to create JSON-RPC 2.0 error response
 */
function createJsonRpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): NextResponse {
  return NextResponse.json(
    {
      jsonrpc: "2.0",
      id,
      error: {
        code,
        message,
        ...(data === undefined ? {} : { data }),
      },
    },
    {
      status: code === -32_700 ? 400 : 200, // Parse errors are 400, others are 200
      headers: CORS_HEADERS,
    },
  );
}
