import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminColdEmailGetSettings,
  adminColdEmailListBlocked,
  adminColdEmailMark,
  adminColdEmailUpdateSettings,
} from "@/utils/mcp-server/tools/admin-cold-email-tools";
import { describe, expect, it, vi } from "vitest";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");
vi.mock("@/utils/rule/learned-patterns", () => ({
  saveLearnedPattern: vi.fn(),
}));

const ctx: McpToolContext = {
  clientId: "client-1",
  userId: "test-user-mcp-ce",
  emailAccountId: "test-acc-mcp-ce",
  scopes: ["admin"],
};

describe("adminColdEmailGetSettings", () => {
  it("returns envelope { ok:true, data } with disabled defaults", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminColdEmailGetSettings(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(false);
      expect(result.data.mode).toBe("DISABLED");
    }
  });

  it("returns settings when rule exists", async () => {
    prisma.rule.findUnique.mockImplementation(((args: unknown) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_x") {
        return Promise.resolve({
          id: "rule_x",
          instructions: "Block recruiters",
        });
      }
      return Promise.resolve({
        id: "rule_x",
        enabled: true,
        instructions: "Block recruiters",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
        ],
      });
    }) as never);

    const result = await adminColdEmailGetSettings(ctx, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.mode).toBe("LABEL");
      expect(result.data.prompt).toBe("Block recruiters");
    }
  });
});

describe("adminColdEmailUpdateSettings", () => {
  it("returns VALIDATION_ERROR on bad mode value", async () => {
    const result = await adminColdEmailUpdateSettings(ctx, { mode: "BOGUS" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("creates rule when enabling for the first time", async () => {
    let count = 0;
    prisma.rule.findUnique.mockImplementation(((args: unknown) => {
      count++;
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_new") {
        return Promise.resolve({
          id: "rule_new",
          instructions: "block all",
        });
      }
      if (count === 1) return Promise.resolve(null);
      return Promise.resolve({
        id: "rule_new",
        enabled: true,
        instructions: "block all",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
          { type: ActionType.ARCHIVE, label: null, labelId: null },
        ],
      });
    }) as never);
    prisma.rule.create.mockResolvedValue({ id: "rule_new" } as never);
    prisma.action.deleteMany.mockResolvedValue({ count: 0 } as never);
    prisma.action.createMany.mockResolvedValue({ count: 2 } as never);

    const result = await adminColdEmailUpdateSettings(ctx, {
      enabled: true,
      mode: "ARCHIVE_AND_LABEL",
      prompt: "block all",
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.mode).toBe("ARCHIVE_AND_LABEL");
    }
  });
});

describe("adminColdEmailListBlocked", () => {
  it("returns empty data when no rule exists", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminColdEmailListBlocked(ctx, { limit: 50 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.items).toEqual([]);
      expect(result.data.total).toBe(0);
    }
  });

  it("applies default limit when not provided", async () => {
    prisma.rule.findUnique.mockResolvedValue({ groupId: null } as never);

    const result = await adminColdEmailListBlocked(ctx, {});

    expect(result.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR for invalid limit", async () => {
    const result = await adminColdEmailListBlocked(ctx, { limit: 0 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("adminColdEmailMark", () => {
  it("returns NOT_FOUND when rule is missing", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminColdEmailMark(ctx, {
      sender: "x@y.com",
      action: "mark",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("marks then unmarks a sender", async () => {
    prisma.rule.findUnique.mockResolvedValue({ id: "rule_1" } as never);

    const marked = await adminColdEmailMark(ctx, {
      sender: "spam@x.com",
      action: "mark",
    });
    expect(marked.ok).toBe(true);

    const unmarked = await adminColdEmailMark(ctx, {
      sender: "spam@x.com",
      action: "unmark",
    });
    expect(unmarked.ok).toBe(true);
  });

  it("returns VALIDATION_ERROR on bad action value", async () => {
    const result = await adminColdEmailMark(ctx, {
      sender: "x@y.com",
      action: "delete",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("cold-email full flow", () => {
  it("get -> update -> mark -> list -> unmark -> list", async () => {
    // Simulated in-memory state for blocked senders + cold-email rule.
    type Row = {
      id: string;
      value: string;
      reason: string | null;
      source: string | null;
      createdAt: Date;
      exclude: boolean;
    };
    const state: {
      ruleId: string | null;
      groupId: string | null;
      enabled: boolean;
      instructions: string | null;
      actions: Array<{ type: string; label: string | null }>;
      groupItems: Row[];
    } = {
      ruleId: null,
      groupId: null,
      enabled: false,
      instructions: null,
      actions: [],
      groupItems: [],
    };

    // rule.findUnique covers both keys (compound key and by id) used internally.
    prisma.rule.findUnique.mockImplementation(((args: unknown) => {
      const a = args as {
        where: { id?: string };
        select?: { actions?: unknown };
      };
      if (state.ruleId === null) return Promise.resolve(null);
      // Re-fetch by id for instructions.
      if (a.where.id) {
        return Promise.resolve({
          id: state.ruleId,
          instructions: state.instructions,
        });
      }
      // Lookup by compound key.
      return Promise.resolve({
        id: state.ruleId,
        enabled: state.enabled,
        instructions: state.instructions,
        groupId: state.groupId,
        actions: state.actions.map((act) => ({ ...act, labelId: null })),
      });
    }) as never);

    prisma.rule.create.mockImplementation((async (args: unknown) => {
      const a = args as { data: { enabled?: boolean; instructions?: string } };
      state.ruleId = "rule_e2e";
      state.enabled = a.data.enabled ?? true;
      state.instructions = a.data.instructions ?? null;
      return { id: state.ruleId };
    }) as never);

    prisma.rule.update.mockImplementation((async (args: unknown) => {
      const a = args as {
        data: { enabled?: boolean; instructions?: string | null };
      };
      if (a.data.enabled !== undefined) state.enabled = a.data.enabled;
      if (a.data.instructions !== undefined)
        state.instructions = a.data.instructions ?? null;
      return { id: state.ruleId };
    }) as never);

    prisma.action.deleteMany.mockImplementation((async () => {
      state.actions = [];
      return { count: 0 };
    }) as never);

    prisma.action.createMany.mockImplementation((async (args: unknown) => {
      const a = args as {
        data: Array<{ type: string; label?: string; ruleId: string }>;
      };
      state.actions = a.data.map((d) => ({
        type: d.type,
        label: d.label ?? null,
      }));
      return { count: state.actions.length };
    }) as never);

    prisma.groupItem.findMany.mockImplementation((async () => {
      const active = state.groupItems
        .filter((r) => !r.exclude)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return active;
    }) as never);

    prisma.groupItem.count.mockImplementation((async () => {
      return state.groupItems.filter((r) => !r.exclude).length;
    }) as never);

    // saveLearnedPattern is mocked at the top; rewire it to mutate state.
    const { saveLearnedPattern } = await import(
      "@/utils/rule/learned-patterns"
    );
    vi.mocked(saveLearnedPattern).mockImplementation(async (args) => {
      // Ensure a group exists once the user starts marking.
      if (!state.groupId) state.groupId = "group_e2e";
      const existing = state.groupItems.find((r) => r.value === args.from);
      if (existing) {
        existing.exclude = args.exclude ?? false;
        existing.reason = args.reason ?? null;
      } else {
        state.groupItems.push({
          id: `gi_${state.groupItems.length + 1}`,
          value: args.from,
          reason: args.reason ?? null,
          source: args.source ?? null,
          createdAt: new Date(),
          exclude: args.exclude ?? false,
        });
      }
    });

    // 1. Initial get: disabled
    const initial = await adminColdEmailGetSettings(ctx, {});
    expect(initial.ok).toBe(true);
    if (initial.ok) expect(initial.data.enabled).toBe(false);

    // 2. Enable with ARCHIVE_AND_LABEL
    const updated = await adminColdEmailUpdateSettings(ctx, {
      enabled: true,
      mode: "ARCHIVE_AND_LABEL",
      prompt: "Block sales pitches and recruiter spam",
      labelName: "Cold Emails",
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.data.enabled).toBe(true);
      expect(updated.data.mode).toBe("ARCHIVE_AND_LABEL");
    }

    // 3. Mark a sender as cold
    const marked = await adminColdEmailMark(ctx, {
      sender: "recruiter@bigco.com",
      action: "mark",
      reason: "Cold recruiter",
    });
    expect(marked.ok).toBe(true);

    // 4. List blocked: should contain the marked sender
    const listed = await adminColdEmailListBlocked(ctx, { limit: 50 });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.items.map((i) => i.sender)).toContain(
        "recruiter@bigco.com",
      );
      expect(listed.data.total).toBeGreaterThanOrEqual(1);
    }

    // 5. Unmark
    const unmarked = await adminColdEmailMark(ctx, {
      sender: "recruiter@bigco.com",
      action: "unmark",
    });
    expect(unmarked.ok).toBe(true);

    // 6. List again: sender no longer present
    const listedAfter = await adminColdEmailListBlocked(ctx, { limit: 50 });
    expect(listedAfter.ok).toBe(true);
    if (listedAfter.ok) {
      expect(listedAfter.data.items.map((i) => i.sender)).not.toContain(
        "recruiter@bigco.com",
      );
    }
  });
});
