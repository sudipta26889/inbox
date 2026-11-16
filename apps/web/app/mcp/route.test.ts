import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";

// Re-fork decision 1: the fork's own MCP server (/mcp-server, slice 5) owns the
// origin's OAuth metadata, so upstream's /mcp server, its better-auth OAuth
// provider and its /.well-known/oauth-* routes stay off. They are kept in the
// tree for upstream merges and switched off by MCP_SERVER_ENABLED, which the
// deploy stacks never set. The fork's /.well-known/* rewrites go in proxy.ts,
// which runs before these route files.
vi.mock("@/env", () => ({
  env: {
    MCP_SERVER_ENABLED: false,
    NEXT_PUBLIC_EXTERNAL_API_ENABLED: true,
    NEXT_PUBLIC_BASE_URL: "https://inbox.example.com",
  },
}));
vi.mock("@/utils/auth", () => ({ betterAuthConfig: {} }));
vi.mock("@/utils/mcp/server", () => ({ handleMcpServerRequest: vi.fn() }));
vi.mock("@/utils/mcp/rate-limit", () => ({
  getMcpIpRateLimitResponse: vi.fn(),
}));
vi.mock("@/utils/mcp/verify-token", () => ({ verifyMcpToken: vi.fn() }));
vi.mock("@/utils/middleware", () => ({
  withError:
    (_scope: string, handler: (request: NextRequest) => Promise<Response>) =>
    (request: NextRequest) =>
      handler(Object.assign(request, { logger: console })),
}));

import * as mcpRoute from "@/app/mcp/route";
import * as apiMcpServerRoute from "@/app/api/mcp-server/route";
import { GET as authServerMetadata } from "@/app/.well-known/oauth-authorization-server/route";
import { GET as authServerMetadataApiAuth } from "@/app/.well-known/oauth-authorization-server/api/auth/route";
import { GET as protectedResource } from "@/app/.well-known/oauth-protected-resource/route";
import { GET as protectedResourceMcp } from "@/app/.well-known/oauth-protected-resource/mcp/route";
import { mcpOAuthPlugins } from "@/utils/mcp/oauth-provider";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..", "..");

describe("upstream MCP server is off", () => {
  const request = () =>
    new NextRequest("https://inbox.example.com/mcp", { method: "POST" });

  it.each([
    ["/mcp", mcpRoute],
    ["/api/mcp-server", apiMcpServerRoute],
  ])("%s answers 404", async (_path, route) => {
    const handlers = route as Record<string, (req: any) => Promise<Response>>;
    for (const method of ["POST", "GET", "OPTIONS"]) {
      const response = await handlers[method](request());
      expect(response.status).toBe(404);
    }
  });

  it("publishes no OAuth metadata from upstream's routes", async () => {
    const metadataRequest = new Request(
      "https://inbox.example.com/.well-known/oauth-authorization-server",
    );

    expect((await authServerMetadata(metadataRequest)).status).toBe(404);
    expect((await authServerMetadataApiAuth(metadataRequest)).status).toBe(404);
    expect((await protectedResource()).status).toBe(404);
    expect((await protectedResourceMcp()).status).toBe(404);
  });

  it("adds no OAuth provider to better-auth", () => {
    expect(mcpOAuthPlugins()).toEqual([]);
  });

  it.each([
    "deploy/stack.yml",
    "deploy/stack.staging.yml",
  ])("%s does not switch it on", (file) => {
    expect(readFileSync(join(REPO_ROOT, file), "utf8")).not.toMatch(
      /^\s*MCP_SERVER_ENABLED:/m,
    );
  });
});
