import { describe, it, expect } from "vitest";
import { MCP_TOOLS, getAllTools, getTool, hasRequiredScope } from "./registry";

const DRAFT_WRITE_TOOLS = ["create_draft", "update_draft", "delete_draft"];

describe("draft/send scope separation", () => {
  it("does not let a drafting agent send mail", () => {
    const agentScopes = ["email:read", "email:draft"];

    expect(hasRequiredScope(MCP_TOOLS.send_email!, agentScopes)).toBe(false);
    for (const name of DRAFT_WRITE_TOOLS) {
      expect(hasRequiredScope(MCP_TOOLS[name]!, agentScopes)).toBe(true);
    }
  });

  it("hides send_email from a drafting agent's tool list", () => {
    const names = getAllTools(["email:read", "email:draft"]).map((t) => t.name);

    expect(names).not.toContain("send_email");
    expect(names).toEqual(expect.arrayContaining(DRAFT_WRITE_TOOLS));
    expect(names).toEqual(
      expect.arrayContaining(["list_drafts", "get_draft", "search_emails"]),
    );
  });

  it("keeps drafting working for tokens issued before the scope split", () => {
    // email:write predates email:draft and used to grant draft writes.
    for (const name of DRAFT_WRITE_TOOLS) {
      expect(hasRequiredScope(MCP_TOOLS[name]!, ["email:write"])).toBe(true);
    }
    expect(getAllTools(["email:write"]).map((t) => t.name)).toEqual(
      expect.arrayContaining([...DRAFT_WRITE_TOOLS, "send_email"]),
    );
  });

  it("does not let the narrower scope imply the broader one", () => {
    expect(hasRequiredScope(MCP_TOOLS.send_email!, ["email:draft"])).toBe(
      false,
    );
  });

  it("still lists everything when no scopes are supplied", () => {
    expect(getAllTools().length).toBe(Object.keys(MCP_TOOLS).length);
  });
});

describe("tool annotations", () => {
  it("marks read tools read-only and leaves writes at the fail-safe default", () => {
    const byName = Object.fromEntries(
      getAllTools().map((tool) => [tool.name, tool]),
    );

    expect(byName.search_emails?.annotations?.readOnlyHint).toBe(true);
    expect(byName.list_drafts?.annotations?.readOnlyHint).toBe(true);
    expect(byName.send_email?.annotations?.readOnlyHint).toBeUndefined();
  });

  it("distinguishes sending from drafting", () => {
    const byName = Object.fromEntries(
      getAllTools().map((tool) => [tool.name, tool]),
    );

    expect(byName.send_email?.annotations?.destructiveHint).toBe(true);
    expect(byName.create_draft?.annotations?.destructiveHint).toBe(false);
    expect(byName.create_draft?.annotations?.openWorldHint).toBe(false);
  });
});

describe("getTool", () => {
  it("returns undefined for an unknown tool", () => {
    expect(getTool("nope")).toBeUndefined();
  });
});
