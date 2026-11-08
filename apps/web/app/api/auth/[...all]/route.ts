import { betterAuthConfig } from "@/utils/auth";
import {
  AUTH_BODY_LIMIT,
  bodyTooLargeResponse,
  readBodyWithLimit,
  rebuildRequest,
} from "@/utils/request-body-limit";
import { toNextJsHandler } from "better-auth/next-js";

const handlers = toNextJsHandler(betterAuthConfig);

export const GET = handlers.GET;

export async function POST(request: Request) {
  const body = await readBodyWithLimit(request, AUTH_BODY_LIMIT);
  if (!body.ok)
    return bodyTooLargeResponse({ error: "Request body too large" });

  return handlers.POST(rebuildRequest(request, body.bytes));
}
