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
