import { describe, it, expect } from "vitest";
import { MCP_SCOPES, MCP_SCOPES_SUPPORTED } from "./constants";
import { MCP_TOOLS } from "./tools/registry";

describe("MCP scopes", () => {
  it("advertises every scope some tool requires", () => {
    // The four .well-known routes serve this list, and clients request exactly
    // what it advertises. A scope missing from it is one no discovering client
    // will ever ask for, so its tools are unreachable — which is precisely how
    // 46 admin tools sat uncallable in the catalogue.
    const required = new Set(
      Object.values(MCP_TOOLS).map((tool) => tool.requiredScope),
    );
    for (const scope of required) {
      expect(MCP_SCOPES_SUPPORTED).toContain(scope);
    }
  });

  it("keeps legacy scopes valid but out of discovery", () => {
    // Still accepted so existing clients keep authorizing; not advertised so
    // new clients discover the granular admin:read / admin:write split rather
    // than requesting one omnibus grant over all 46 admin tools.
    for (const legacy of ["admin", "mcp:read", "mcp:write"]) {
      expect(MCP_SCOPES).toHaveProperty(legacy);
      expect(MCP_SCOPES_SUPPORTED).not.toContain(legacy);
    }
  });

  it("advertises the split admin scopes", () => {
    expect(MCP_SCOPES_SUPPORTED).toContain("admin:read");
    expect(MCP_SCOPES_SUPPORTED).toContain("admin:write");
  });

  it("includes the draft scope", () => {
    expect(MCP_SCOPES_SUPPORTED).toContain("email:draft");
  });
});
