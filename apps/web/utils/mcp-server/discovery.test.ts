import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server";
import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { config, proxy } from "@/proxy";
import production from "./discovery.production.json";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BASE_URL: "https://inbox.sudiptadhara.in" },
}));

// Existing MCP clients cached these documents; any drift in issuer, endpoints
// or scopes breaks their token refresh after the re-fork.
describe("MCP OAuth discovery served by proxy.ts", () => {
  it.each(
    Object.entries(production.bodies),
  )("serves %s byte-identical to production", async (path, body) => {
    const response = proxy(
      new NextRequest(`https://inbox.sudiptadhara.in${path}`),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("runs the proxy for every discovery path, before upstream's route files", () => {
    for (const path of Object.keys(production.bodies)) {
      expect(unstable_doesMiddlewareMatch({ config, url: path }), path).toBe(
        true,
      );
    }
  });

  it("leaves upstream's own /mcp discovery path to its flag-gated route", () => {
    const response = proxy(
      new NextRequest(
        "https://inbox.sudiptadhara.in/.well-known/oauth-protected-resource/mcp",
      ),
    );

    expect(response.headers.get("x-middleware-next")).toBe("1");
  });
});
