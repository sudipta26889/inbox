import { ActionType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getColdEmailSettings } from "@/utils/cold-email/domain";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma");

const ctx = { userId: "test-user-1", emailAccountId: "test-acc-1" };

describe("getColdEmailSettings", () => {
  it("returns disabled when no cold-email rule exists", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await getColdEmailSettings(ctx);

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe("DISABLED");
    expect(result.prompt).toBeNull();
    expect(result.ruleId).toBeNull();
    expect(result.labelName).toBeNull();
  });

  it("returns enabled + prompt + mode when rule exists with ARCHIVE+LABEL", async () => {
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      // Second call: re-fetch for instructions
      if (a.where?.id === "rule_1") {
        return Promise.resolve({
          id: "rule_1",
          instructions: "Block recruiters",
        } as never) as never;
      }
      // First call: by emailAccountId + systemType
      return Promise.resolve({
        id: "rule_1",
        enabled: true,
        instructions: "Block recruiters",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
          { type: ActionType.ARCHIVE, label: null, labelId: null },
        ],
      } as never) as never;
    });

    const result = await getColdEmailSettings(ctx);

    expect(result.enabled).toBe(true);
    expect(result.mode).toBe("ARCHIVE_AND_LABEL");
    expect(result.prompt).toBe("Block recruiters");
    expect(result.ruleId).toBe("rule_1");
    expect(result.labelName).toBe("Cold Emails");
  });

  it("returns LABEL mode when only LABEL action present", async () => {
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_2") {
        return Promise.resolve({
          id: "rule_2",
          instructions: "Tag cold",
        } as never) as never;
      }
      return Promise.resolve({
        id: "rule_2",
        enabled: true,
        instructions: "Tag cold",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
        ],
      } as never) as never;
    });

    const result = await getColdEmailSettings(ctx);

    expect(result.mode).toBe("LABEL");
  });

  it("returns ARCHIVE_AND_READ_AND_LABEL with all three actions", async () => {
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_3") {
        return Promise.resolve({
          id: "rule_3",
          instructions: null,
        } as never) as never;
      }
      return Promise.resolve({
        id: "rule_3",
        enabled: true,
        instructions: null,
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
          { type: ActionType.ARCHIVE, label: null, labelId: null },
          { type: ActionType.MARK_READ, label: null, labelId: null },
        ],
      } as never) as never;
    });

    const result = await getColdEmailSettings(ctx);

    expect(result.mode).toBe("ARCHIVE_AND_READ_AND_LABEL");
  });
});
