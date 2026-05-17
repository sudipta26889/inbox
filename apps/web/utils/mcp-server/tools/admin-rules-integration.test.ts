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

import {
  adminRulesList,
  adminRulesCreate,
  adminRulesUpdate,
  adminRulesSetEnabled,
  adminRulesDelete,
} from "./admin-rules-tools";

const ctx = {
  clientId: "client_test",
  emailAccountId: "ea_1",
  scopes: ["admin"],
  userId: "user_1",
};

const createdRule = {
  id: "r_created",
  name: "Newsletters",
  enabled: true,
  runOnThreads: false,
  displayOrder: 0,
  systemType: null,
  instructions: "filter newsletters",
  createdAt: new Date("2026-03-01"),
  updatedAt: new Date("2026-03-01"),
  actions: [{ id: "a_1", type: "LABEL", label: "test-label" }],
  group: null,
  groupId: null,
};

describe("admin_rules_* end-to-end", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      account: { provider: "google" },
    });
  });

  it("lists empty → creates → updates → toggles → previews delete → confirms delete", async () => {
    // 1. list — empty
    prisma.rule.findMany.mockResolvedValueOnce([]);
    const listed = await adminRulesList(ctx, {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect((listed.data as any).count).toBe(0);
    }

    // 2. create
    prisma.rule.create.mockResolvedValueOnce(createdRule);
    const created = await adminRulesCreate(ctx, {
      name: "Newsletters",
      runOnThreads: false,
      actions: [
        { type: "LABEL", labelId: { value: null, name: "test-label" } },
      ],
      conditions: [{ type: "AI", instructions: "filter newsletters" }],
    });
    expect(created.ok).toBe(true);
    if (created.ok) {
      expect((created.data as any).rule.id).toBe("r_created");
    }

    // 3. update
    prisma.rule.findFirst.mockResolvedValueOnce({
      id: "r_created",
      emailAccountId: "ea_1",
    });
    prisma.rule.update.mockResolvedValueOnce({
      ...createdRule,
      name: "Newsletters (renamed)",
    });
    const updated = await adminRulesUpdate(ctx, {
      id: "r_created",
      name: "Newsletters (renamed)",
      runOnThreads: false,
      actions: [
        { type: "LABEL", labelId: { value: null, name: "test-label" } },
      ],
      conditions: [{ type: "AI", instructions: "filter newsletters" }],
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect((updated.data as any).rule.name).toBe("Newsletters (renamed)");
    }

    // 4. set_enabled false
    prisma.rule.findFirst.mockResolvedValueOnce({ id: "r_created" });
    prisma.rule.update.mockResolvedValueOnce({
      ...createdRule,
      enabled: false,
    });
    const toggled = await adminRulesSetEnabled(ctx, {
      ruleId: "r_created",
      enabled: false,
    });
    expect(toggled.ok).toBe(true);
    if (toggled.ok) {
      expect((toggled.data as any).rule.enabled).toBe(false);
    }

    // 5. delete dry-run
    prisma.rule.findFirst.mockResolvedValueOnce({
      id: "r_created",
      name: "Newsletters (renamed)",
      groupId: null,
      actions: [{ id: "a_1" }],
    });
    const previewDelete = await adminRulesDelete(ctx, { id: "r_created" });
    expect(previewDelete).toEqual({
      ok: true,
      dryRun: true,
      preview: {
        action: "delete_rule",
        rule: {
          id: "r_created",
          name: "Newsletters (renamed)",
          actionCount: 1,
        },
        irreversible: true,
      },
    });
    expect(prisma.rule.delete).not.toHaveBeenCalled();

    // 6. delete confirmed
    prisma.rule.findFirst.mockResolvedValueOnce({
      id: "r_created",
      groupId: null,
    });
    prisma.rule.delete.mockResolvedValueOnce({ id: "r_created" });
    const confirmedDelete = await adminRulesDelete(ctx, {
      id: "r_created",
      confirm: true,
    });
    expect(confirmedDelete.ok).toBe(true);
    if (confirmedDelete.ok) {
      expect(confirmedDelete.dryRun).toBe(false);
      expect((confirmedDelete.data as any).id).toBe("r_created");
    }
    expect(prisma.rule.delete).toHaveBeenCalledWith({
      where: { id: "r_created", emailAccountId: "ea_1" },
    });
  });
});
