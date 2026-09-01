import { describe, it, expect } from "vitest";
import { MCP_SCOPES, MCP_SCOPES_SUPPORTED } from "./constants";
import { MCP_TOOLS } from "./tools/registry";

describe("MCP scopes", () => {
  it("advertises every scope the server enforces", () => {
    // The four .well-known routes serve this list. A scope missing from it is
    // one no discovering client will request, so the tool is unreachable.
    expect(new Set(MCP_SCOPES_SUPPORTED)).toEqual(
      new Set(Object.keys(MCP_SCOPES)),
    );
  });

  it("advertises every scope some tool actually requires", () => {
    const required = new Set(
      Object.values(MCP_TOOLS).map((tool) => tool.requiredScope),
    );

    for (const scope of required) {
      expect(MCP_SCOPES_SUPPORTED).toContain(scope);
    }
  });

  it("includes the draft scope", () => {
    expect(MCP_SCOPES_SUPPORTED).toContain("email:draft");
  });
});
