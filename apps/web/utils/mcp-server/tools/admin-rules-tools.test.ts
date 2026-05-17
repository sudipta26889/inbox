import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@/utils/rule/rule-history", () => ({
  createRuleHistory: vi.fn(),
}));
vi.mock("@/utils/email/provider-types", () => ({
  isMicrosoftProvider: vi.fn(() => false),
  isGoogleProvider: vi.fn(() => true),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue({
    getOrCreateFolderIdByName: vi.fn().mockResolvedValue("folder_id"),
  }),
}));
vi.mock("@/utils/label/resolve-label", () => ({
  resolveLabelNameAndId: vi
    .fn()
    .mockResolvedValue({ label: "test-label", labelId: "label_id" }),
}));
vi.mock("@/utils/rule/recipient-validation", () => ({
  getMissingRecipientMessage: vi.fn(() => null),
  addMissingRecipientIssue: vi.fn(),
}));
vi.mock("@/utils/prisma-helpers", () => ({
  isDuplicateError: vi.fn(() => false),
  isNotFoundError: vi.fn(() => false),
}));
vi.mock("@/utils/risk", () => ({
  getActionRiskLevel: vi.fn(() => ({ level: "low" })),
}));
vi.mock("@/app/(app)/[emailAccountId]/assistant/examples", () => ({
  hasExampleParams: vi.fn(() => false),
}));

const ctx = {
  clientId: "client_test",
  emailAccountId: "ea_1",
  scopes: ["admin"],
  userId: "user_1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

import { adminRulesList } from "./admin-rules-tools";
import { adminRulesGet } from "./admin-rules-tools";
import { adminRulesCreate } from "./admin-rules-tools";
import { adminRulesUpdate } from "./admin-rules-tools";
import { adminRulesDelete } from "./admin-rules-tools";
import { adminRulesSetEnabled } from "./admin-rules-tools";

describe("adminRulesList", () => {
  it("returns the rules ordered by displayOrder then createdAt for the email account", async () => {
    prisma.rule.findMany.mockResolvedValue([
      {
        id: "r_1",
        name: "Newsletters",
        enabled: true,
        runOnThreads: false,
        displayOrder: 0,
        systemType: null,
        instructions: null,
        createdAt: new Date("2026-01-01"),
        updatedAt: new Date("2026-01-02"),
        actions: [],
      },
    ]);

    const out = await adminRulesList(ctx, {});

    expect(out).toEqual({
      ok: true,
      data: {
        rules: [
          {
            id: "r_1",
            name: "Newsletters",
            enabled: true,
            runOnThreads: false,
            displayOrder: 0,
            systemType: null,
            instructions: null,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-02T00:00:00.000Z",
            actions: [],
          },
        ],
        count: 1,
      },
    });

    expect(prisma.rule.findMany).toHaveBeenCalledWith({
      where: { emailAccountId: "ea_1" },
      include: { actions: true },
      orderBy: [{ displayOrder: "asc" }, { createdAt: "asc" }],
    });
  });
});

describe("adminRulesGet", () => {
  it("returns the rule with actions and group when it exists for the account", async () => {
    prisma.rule.findFirst.mockResolvedValue({
      id: "r_1",
      name: "Newsletters",
      enabled: true,
      runOnThreads: false,
      displayOrder: 0,
      systemType: null,
      instructions: null,
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-02"),
      actions: [],
      group: null,
    });

    const out = await adminRulesGet(ctx, { id: "r_1" });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).rule.id).toBe("r_1");
    }
    expect(prisma.rule.findFirst).toHaveBeenCalledWith({
      where: { id: "r_1", emailAccountId: "ea_1" },
      include: { actions: true, group: true },
    });
  });

  it("returns NOT_FOUND when the rule does not exist for the account", async () => {
    prisma.rule.findFirst.mockResolvedValue(null);

    const out = await adminRulesGet(ctx, { id: "r_missing" });

    expect(out).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Rule not found" },
    });
  });

  it("returns VALIDATION_ERROR when id is missing", async () => {
    const out = await adminRulesGet(ctx, {});
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("adminRulesCreate", () => {
  it("creates a rule via the domain function and returns its data", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    });
    prisma.rule.create.mockResolvedValue({
      id: "r_new",
      name: "New rule",
      actions: [{ id: "a_1", type: "LABEL", label: "test-label" }],
      enabled: true,
      runOnThreads: true,
      displayOrder: 0,
      systemType: null,
      instructions: null,
      createdAt: new Date("2026-02-01"),
      updatedAt: new Date("2026-02-01"),
      group: null,
    });

    const out = await adminRulesCreate(ctx, {
      name: "New rule",
      runOnThreads: true,
      actions: [
        {
          type: "LABEL",
          labelId: { value: null, name: "test-label" },
        },
      ],
      conditions: [{ type: "AI", instructions: "match newsletters" }],
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).rule.id).toBe("r_new");
    }
    expect(prisma.rule.create).toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR when the body fails Zod validation", async () => {
    const out = await adminRulesCreate(ctx, { name: "" });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION_ERROR");
    }
  });
});

describe("adminRulesUpdate", () => {
  it("verifies ownership and updates via the domain function", async () => {
    prisma.rule.findFirst.mockResolvedValue({
      id: "r_1",
      emailAccountId: "ea_1",
    });
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    });
    prisma.rule.update.mockResolvedValue({
      id: "r_1",
      name: "Renamed",
      actions: [],
      enabled: true,
      runOnThreads: false,
      displayOrder: 0,
      systemType: null,
      instructions: null,
      createdAt: new Date("2026-02-01"),
      updatedAt: new Date("2026-02-02"),
      group: null,
    });

    const out = await adminRulesUpdate(ctx, {
      id: "r_1",
      name: "Renamed",
      actions: [
        { type: "LABEL", labelId: { value: null, name: "test-label" } },
      ],
      conditions: [{ type: "AI", instructions: "match" }],
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).rule.id).toBe("r_1");
    }
  });

  it("returns NOT_FOUND when the rule does not belong to the account", async () => {
    prisma.rule.findFirst.mockResolvedValue(null);

    const out = await adminRulesUpdate(ctx, {
      id: "r_other",
      name: "x",
      actions: [
        { type: "LABEL", labelId: { value: null, name: "test-label" } },
      ],
      conditions: [{ type: "AI", instructions: "match" }],
    });

    expect(out).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Rule not found" },
    });
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });
});

describe("adminRulesDelete", () => {
  it("returns a dryRun preview and does NOT delete when confirm is omitted", async () => {
    prisma.rule.findFirst.mockResolvedValue({
      id: "r_1",
      name: "Newsletters",
      groupId: null,
      actions: [{ id: "a_1" }, { id: "a_2" }],
    });

    const out = await adminRulesDelete(ctx, { id: "r_1" });

    expect(out).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        action: "delete_rule",
        rule: { id: "r_1", name: "Newsletters", actionCount: 2 },
        irreversible: true,
      },
    });
    expect(prisma.rule.delete).not.toHaveBeenCalled();
    expect(prisma.group.deleteMany).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the rule does not belong to the account", async () => {
    prisma.rule.findFirst.mockResolvedValue(null);
    const out = await adminRulesDelete(ctx, { id: "r_missing" });
    expect(out).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Rule not found" },
    });
  });

  it("deletes the rule when confirm is true", async () => {
    prisma.rule.findFirst.mockResolvedValue({
      id: "r_1",
      name: "Newsletters",
      groupId: null,
      actions: [],
    });
    prisma.rule.delete.mockResolvedValue({ id: "r_1" });

    const out = await adminRulesDelete(ctx, { id: "r_1", confirm: true });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.dryRun).toBe(false);
    }
    expect(prisma.rule.delete).toHaveBeenCalledWith({
      where: { id: "r_1", emailAccountId: "ea_1" },
    });
  });

  it("returns STALE_STATE when the rule disappears between dry-run and confirm", async () => {
    prisma.rule.findFirst.mockResolvedValue(null);

    const out = await adminRulesDelete(ctx, { id: "r_1", confirm: true });

    expect(out).toEqual({
      ok: false,
      error: { code: "STALE_STATE", message: "Rule no longer exists" },
    });
  });
});

describe("adminRulesSetEnabled", () => {
  it("toggles enabled via partialUpdateRule when ownership is verified", async () => {
    prisma.rule.findFirst.mockResolvedValue({ id: "r_1" });
    prisma.rule.update.mockResolvedValue({
      id: "r_1",
      enabled: false,
      actions: [],
      group: null,
    });

    const out = await adminRulesSetEnabled(ctx, {
      ruleId: "r_1",
      enabled: false,
    });

    expect(out.ok).toBe(true);
    if (out.ok) {
      expect((out.data as any).rule.enabled).toBe(false);
    }
    expect(prisma.rule.update).toHaveBeenCalledWith({
      where: { id: "r_1" },
      data: { enabled: false },
      include: { actions: true, group: true },
    });
  });

  it("returns NOT_FOUND when the rule does not belong to the account", async () => {
    prisma.rule.findFirst.mockResolvedValue(null);
    const out = await adminRulesSetEnabled(ctx, {
      ruleId: "r_other",
      enabled: true,
    });
    expect(out).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "Rule not found" },
    });
    expect(prisma.rule.update).not.toHaveBeenCalled();
  });

  it("returns VALIDATION_ERROR when neither ruleId nor systemType is given", async () => {
    const out = await adminRulesSetEnabled(ctx, { enabled: true });
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("VALIDATION_ERROR");
    }
  });
});
