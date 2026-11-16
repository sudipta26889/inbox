import { describe, it, expect } from "vitest";
import { A2A_SKILL_REGISTRY } from "@/utils/a2a/skill-registry";
import { MCP_TOOLS, getAllTools, getTool, hasRequiredScope } from "./registry";
import { TOOL_METADATA } from "./tool-metadata";

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

const DESTRUCTIVE_TOOLS = [
  "send_email",
  "delete_draft",
  "delete_calendar_event",
  "admin_rules_delete",
  "admin_categories_delete",
  "admin_groups_delete",
  "admin_knowledge_delete",
  "admin_follow_ups_delete",
  "admin_unsubscribe_request",
  "admin_cleanup_create_job",
];

const OPEN_WORLD_TOOLS = [
  "send_email",
  "create_calendar_event",
  "update_calendar_event",
  "delete_calendar_event",
  "respond_to_calendar_event",
  "admin_unsubscribe_request",
];

describe("tool titles and annotations", () => {
  const tools = () => getAllTools();
  const names = (filter: (tool: ReturnType<typeof tools>[number]) => boolean) =>
    tools()
      .filter(filter)
      .map((tool) => tool.name)
      .sort();

  it("describes every registered tool", () => {
    expect(
      tools()
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(Object.keys(MCP_TOOLS).sort());
  });

  it("has metadata for exactly the registered tools, so none relies on the cautious fallback", () => {
    expect(Object.keys(TOOL_METADATA).sort()).toEqual(
      Object.keys(MCP_TOOLS).sort(),
    );
  });

  it("gives every tool a non-empty title and four boolean hints", () => {
    for (const tool of tools()) {
      expect(tool.title, tool.name).toBeTruthy();
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof tool.annotations?.[hint], `${tool.name}.${hint}`).toBe(
          "boolean",
        );
      }
    }
  });

  it("marks exactly the :read-scoped tools read-only, non-destructive and idempotent", () => {
    for (const [name, definition] of Object.entries(MCP_TOOLS)) {
      const annotations = tools().find(
        (tool) => tool.name === name,
      )?.annotations;
      const isRead = definition.requiredScope.endsWith(":read");

      expect(annotations?.readOnlyHint, name).toBe(isRead);
      if (isRead) {
        expect(annotations?.destructiveHint, name).toBe(false);
        expect(annotations?.idempotentHint, name).toBe(true);
        expect(annotations?.openWorldHint, name).toBe(false);
      }
    }
  });

  it("never lets a read-only tool also be destructive", () => {
    for (const tool of tools()) {
      if (tool.annotations?.readOnlyHint) {
        expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      }
    }
  });

  it("flags exactly the agreed destructive tools", () => {
    expect(names((tool) => tool.annotations?.destructiveHint === true)).toEqual(
      [...DESTRUCTIVE_TOOLS].sort(),
    );
  });

  it("flags every admin_*_delete tool as destructive", () => {
    const deletes = Object.keys(MCP_TOOLS).filter((name) =>
      /^admin_.*_delete$/.test(name),
    );

    expect(deletes.length).toBeGreaterThan(0);
    for (const name of deletes) expect(DESTRUCTIVE_TOOLS).toContain(name);
  });

  it("flags exactly the agreed open-world tools, drafts included as closed", () => {
    expect(names((tool) => tool.annotations?.openWorldHint === true)).toEqual(
      [...OPEN_WORLD_TOOLS].sort(),
    );
    const drafts = tools().filter((tool) => tool.name.endsWith("_draft"));
    for (const tool of drafts) {
      expect(tool.annotations?.openWorldHint, tool.name).toBe(false);
    }
  });

  it("keeps every tool name within 64 characters", () => {
    for (const name of Object.keys(MCP_TOOLS)) {
      expect(name.length, name).toBeLessThanOrEqual(64);
    }
  });

  it("offers get_attachment to a read-only token as a read-only tool", () => {
    const tool = getAllTools(["email:read"]).find(
      (t) => t.name === "get_attachment",
    );

    expect(MCP_TOOLS.get_attachment?.requiredScope).toBe("email:read");
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tool?.inputSchema.required).toEqual(["messageId", "attachmentId"]);
  });

  it("distinguishes sending from drafting", () => {
    const byName = Object.fromEntries(
      getAllTools().map((tool) => [tool.name, tool]),
    );

    expect(byName.send_email?.annotations?.destructiveHint).toBe(true);
    expect(byName.create_draft?.annotations?.destructiveHint).toBe(false);
    expect(byName.create_draft?.annotations?.openWorldHint).toBe(false);
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

  it("treats delete as destructive and update as an open-world edit", () => {
    // delete removes an event outright. update edits one and can notify
    // attendees, so it is open-world but, per the agreed list, not destructive.
    const tools = byName();
    expect(tools.delete_calendar_event?.annotations?.destructiveHint).toBe(
      true,
    );
    expect(tools.update_calendar_event?.annotations?.destructiveHint).toBe(
      false,
    );
    expect(tools.update_calendar_event?.annotations?.openWorldHint).toBe(true);
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

  it("marks admin reads read-only and admin writes explicitly not", () => {
    const byName = Object.fromEntries(getAllTools().map((t) => [t.name, t]));
    expect(byName.admin_rules_list?.annotations?.readOnlyHint).toBe(true);
    expect(byName.admin_rules_delete?.annotations?.readOnlyHint).toBe(false);
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
