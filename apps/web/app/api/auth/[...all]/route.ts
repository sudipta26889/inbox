import { betterAuthConfig } from "@/utils/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { deduplicateOAuthCallback } from "@/utils/oauth/auth-callback-deduplication";
import { createScopedLogger } from "@/utils/logger";
import { isMcpServerAvailable } from "@/utils/mcp/config";
import { getMcpOAuthRateLimitResponse } from "@/utils/mcp/rate-limit";
import {
  AUTH_BODY_LIMIT,
  bodyTooLargeResponse,
  readBodyWithLimit,
  rebuildRequest,
} from "@/utils/request-body-limit";

const logger = createScopedLogger("auth/oauth-callback");
const handlers = toNextJsHandler(betterAuthConfig);

export const maxDuration = 300;
export const { PUT, PATCH, DELETE } = handlers;

export const POST: typeof handlers.POST = async (request) => {
  return withMcpOAuthRateLimit(request, async () => {
    // Read through a hard byte limit: this route is public and better-auth
    // would otherwise buffer any body it is sent.
    const body = await readBodyWithLimit(request, AUTH_BODY_LIMIT);
    if (!body.ok)
      return bodyTooLargeResponse({ error: "Request body too large" });

    return handlers.POST(rebuildRequest(request, body.bytes));
  });
};

export const GET: typeof handlers.GET = async (...args) => {
  const [request] = args;

  return withMcpOAuthRateLimit(request, () =>
    deduplicateOAuthCallback({
      request,
      handleRequest: () => handlers.GET(...args),
      logger,
    }),
  );
};

async function withMcpOAuthRateLimit(
  request: Request,
  handle: () => ReturnType<typeof handlers.POST>,
) {
  if (!isMcpServerAvailable()) return handle();
  const limited = await getMcpOAuthRateLimitResponse({ request, logger });
  if (limited) return limited;
  return handle();
}
