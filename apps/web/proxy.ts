import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import {
  appendVaryAccept,
  prefersMarkdown,
} from "@/utils/agent-markdown/accept";
import {
  getMarkdownForPath,
  markdownResponse,
} from "@/utils/agent-markdown/content";
import { env } from "@/env";
import { BRAND_NAME, SUPPORT_EMAIL } from "@/utils/branding";
import { discoveryResponse } from "@/utils/mcp-server/discovery";

export function proxy(request: NextRequest) {
  const discovery = discoveryResponse(request.nextUrl.pathname);
  if (discovery) return discovery;

  if (isNextInternalRequest(request)) {
    return withVaryAccept(NextResponse.next());
  }

  // The agent Markdown for / and /pricing describes paid plans; with no
  // billing on this deployment the HTML pages answer instead.
  if (env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS) {
    return withVaryAccept(NextResponse.next());
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return withVaryAccept(NextResponse.next());
  }

  if (!prefersMarkdown(request.headers.get("accept"))) {
    return withVaryAccept(NextResponse.next());
  }

  const pageMarkdown = getMarkdownForPath(
    request.nextUrl.pathname,
    request.nextUrl.origin,
    { brandName: BRAND_NAME, supportEmail: SUPPORT_EMAIL },
  );
  if (pageMarkdown) {
    return markdownResponse(pageMarkdown);
  }

  return withVaryAccept(NextResponse.next());
}

export const config = {
  matcher: [
    "/",
    "/pricing",
    // The fork's /mcp-server OAuth discovery (utils/mcp-server/discovery.ts).
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-protected-resource/:path*",
  ],
};

function isNextInternalRequest(request: NextRequest): boolean {
  return (
    request.headers.has("rsc") ||
    request.headers.has("next-router-state-tree") ||
    request.headers.has("next-router-prefetch") ||
    request.headers.has("next-router-segment-prefetch")
  );
}

function withVaryAccept(response: NextResponse): NextResponse {
  appendVaryAccept(response.headers);
  return response;
}
