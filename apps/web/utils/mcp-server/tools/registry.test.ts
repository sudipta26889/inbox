import { describe, it, expect } from "vitest";
import { A2A_SKILL_REGISTRY } from "@/utils/a2a/skill-registry";
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

describe("admin tool annotations", () => {
  const byName = () =>
    Object.fromEntries(getAllTools().map((tool) => [tool.name, tool]));

  it("marks verified read-only admin tools as read-only", () => {
    const tools = byName();
    for (const name of [
      "admin_rules_list",
      "admin_rules_get",
      "admin_knowledge_list",
      "admin_account_get",
      "admin_digest_get",
      "admin_unsubscribe_list",
    ]) {
      expect(tools[name]?.annotations?.readOnlyHint).toBe(true);
    }
  });

  it("leaves mutating admin tools at the fail-safe default", () => {
    const tools = byName();
    for (const name of [
      "admin_rules_delete",
      "admin_rules_create",
      "admin_knowledge_delete",
      "admin_groups_delete",
      "admin_cleanup_create_job",
      "admin_unsubscribe_request",
    ]) {
      expect(tools[name]?.annotations?.readOnlyHint).toBeUndefined();
    }
  });

  it("never marks a tool read-only that can write", () => {
    // A write tool claiming readOnlyHint gets auto-approved by consumers.
    const readOnly = getAllTools()
      .filter((tool) => tool.annotations?.readOnlyHint)
      .map((tool) => tool.name);

    for (const name of readOnly) {
      expect(name).not.toMatch(
        /_(create|update|delete|remove|add|set|reorder|categorize|mark|request)(_|$)/,
      );
    }
  });
});

describe("calendar tool annotations", () => {
  const byName = () =>
    Object.fromEntries(getAllTools().map((tool) => [tool.name, tool]));

  it("marks create_calendar_event as additive, not destructive", () => {
    // create_calendar_event only ever adds a new event; consumers read
    // destructiveHint to decide human-approval policy, so a wrong claim
    // here either scares off a safe call or waves through a risky one.
    const tools = byName();
    expect(tools.create_calendar_event?.annotations?.destructiveHint).toBe(
      false,
    );
  });

  it("leaves update and delete calendar events at the fail-safe destructive default", () => {
    // update overwrites fields and can uninvite attendees; delete removes
    // an event outright — neither may claim destructiveHint: false.
    const tools = byName();
    expect(tools.update_calendar_event?.annotations?.destructiveHint).not.toBe(
      false,
    );
    expect(tools.delete_calendar_event?.annotations?.destructiveHint).toBe(
      true,
    );
  });

  it("does not claim delete_calendar_event is idempotent", () => {
    // A second delete of the same event 410s from Google and throws.
    const tools = byName();
    expect(tools.delete_calendar_event?.annotations?.idempotentHint).not.toBe(
      true,
    );
  });
});

describe("admin scope split", () => {
  const ADMIN_TOOLS = Object.values(MCP_TOOLS).filter((t) =>
    t.name.startsWith("admin_"),
  );

  it("reaches every admin tool through the granular scopes", () => {
    // The original failure: `admin` was never advertised in OAuth discovery, so
    // no client ever requested it and all 46 admin tools were uncallable from
    // the day they shipped. Granting the split pair must reach all of them.
    const granted = ["admin:read", "admin:write"];
    for (const tool of ADMIN_TOOLS) {
      expect(hasRequiredScope(tool, granted)).toBe(true);
    }
    expect(ADMIN_TOOLS.length).toBe(46);
  });

  it("gives admin:read the reads and none of the writes", () => {
    const visible = getAllTools(["admin:read"]).map((t) => t.name);

    expect(visible).toHaveLength(17);
    expect(visible).toEqual(
      expect.arrayContaining(["admin_rules_list", "admin_knowledge_get"]),
    );
    for (const name of visible) {
      expect(name).not.toMatch(
        /_(create|update|delete|set|add|remove|reorder|categorize|mark|request)(_|$)/,
      );
    }
  });

  it("does not let admin:read reach a mutating admin tool", () => {
    expect(
      hasRequiredScope(MCP_TOOLS.admin_rules_delete!, ["admin:read"]),
    ).toBe(false);
    expect(
      hasRequiredScope(MCP_TOOLS.admin_knowledge_create!, ["admin:read"]),
    ).toBe(false);
  });

  it("still honours the legacy omnibus admin scope", () => {
    // No token has ever held it, but a client that hardcoded it must not break.
    expect(getAllTools(["admin"])).toHaveLength(46);
  });

  it("marks admin reads read-only purely from the scope suffix", () => {
    const byName = Object.fromEntries(getAllTools().map((t) => [t.name, t]));
    expect(byName.admin_rules_list?.annotations?.readOnlyHint).toBe(true);
    expect(
      byName.admin_rules_delete?.annotations?.readOnlyHint,
    ).toBeUndefined();
  });
});

describe("getTool", () => {
  it("returns undefined for an unknown tool", () => {
    expect(getTool("nope")).toBeUndefined();
  });
});

describe("A2A skill registry", () => {
  // A skill pointing at a missing tool only fails on a live A2A call.
  it("maps every skill to a tool that exists", () => {
    for (const [skill, definition] of Object.entries(A2A_SKILL_REGISTRY)) {
      expect(
        getTool(definition.mcpTool),
        `skill ${skill} -> missing tool ${definition.mcpTool}`,
      ).toBeDefined();
    }
  });

  it("requires a scope the tool it maps to also requires", () => {
    for (const [skill, definition] of Object.entries(A2A_SKILL_REGISTRY)) {
      expect(
        getTool(definition.mcpTool)?.requiredScope,
        `skill ${skill} scope mismatch`,
      ).toBe(definition.requiredScope);
    }
  });
});
