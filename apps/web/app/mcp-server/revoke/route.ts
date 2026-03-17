import { NextRequest, NextResponse } from "next/server";
import { revokeAccessToken } from "@/utils/mcp-server/tokens";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("mcp-server/revoke");

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

/**
 * OAuth 2.0 Token Revocation Endpoint (RFC 7009)
 * Always returns 200 per spec, even if token not found.
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const token = formData.get("token")?.toString();

    if (!token) {
      return NextResponse.json(
        { error: "invalid_request", error_description: "Missing required parameter: token" },
        { status: 400, headers: CORS_HEADERS },
      );
    }

    await revokeAccessToken(token, env.AUTH_SECRET || env.NEXTAUTH_SECRET || "");

    logger.info("MCP token revoked");
  } catch (error: any) {
    logger.error("Token revocation error", { error: error.message });
  }

  // RFC 7009: always return 200 regardless of whether token was found
  return new NextResponse(null, {
    status: 200,
    headers: { ...CORS_HEADERS, "Cache-Control": "no-store", Pragma: "no-cache" },
  });
}
