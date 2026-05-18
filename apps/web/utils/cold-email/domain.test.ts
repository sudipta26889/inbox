import { ActionType, SystemType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
  getColdEmailSettings,
  updateColdEmailSettings,
} from "@/utils/cold-email/domain";
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

describe("updateColdEmailSettings", () => {
  it("creates the cold-email rule when none exists and enabled=true", async () => {
    // First call (in updateColdEmailSettings): existing lookup -> null
    // Second call (in getColdEmailSettings): rule lookup after creation
    // Third call (in getColdEmailSettings): re-fetch instructions
    let lookupCount = 0;
    prisma.rule.findUnique.mockImplementation((args: never) => {
      lookupCount++;
      const a = args as { where?: { id?: string } };
      // Detail re-fetch
      if (a.where?.id === "rule_new") {
        return Promise.resolve({
          id: "rule_new",
          instructions: "Block all sales pitches",
        } as never) as never;
      }
      if (lookupCount === 1) {
        // First lookup before creation
        return Promise.resolve(null as never) as never;
      }
      // After create: cold email rule exists
      return Promise.resolve({
        id: "rule_new",
        enabled: true,
        instructions: "Block all sales pitches",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
          { type: ActionType.ARCHIVE, label: null, labelId: null },
        ],
      } as never) as never;
    });
    prisma.rule.create.mockResolvedValue({ id: "rule_new" } as never);
    prisma.action.deleteMany.mockResolvedValue({ count: 0 } as never);
    prisma.action.createMany.mockResolvedValue({ count: 2 } as never);

    const result = await updateColdEmailSettings(ctx, {
      enabled: true,
      prompt: "Block all sales pitches",
      mode: "ARCHIVE_AND_LABEL",
    });

    expect(result.enabled).toBe(true);
    expect(result.mode).toBe("ARCHIVE_AND_LABEL");
    expect(result.prompt).toBe("Block all sales pitches");

    expect(prisma.rule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailAccountId: ctx.emailAccountId,
          systemType: SystemType.COLD_EMAIL,
          enabled: true,
          instructions: "Block all sales pitches",
        }),
      }),
    );
    expect(prisma.action.createMany).toHaveBeenCalledWith({
      data: [
        {
          type: ActionType.LABEL,
          label: "Cold Emails",
          ruleId: "rule_new",
        },
        { type: ActionType.ARCHIVE, ruleId: "rule_new" },
      ],
    });
  });

  it("updates prompt without changing mode when only prompt provided", async () => {
    // Existing rule lookup + post-update get re-fetches
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_existing") {
        return Promise.resolve({
          id: "rule_existing",
          instructions: "updated",
        } as never) as never;
      }
      return Promise.resolve({
        id: "rule_existing",
        enabled: true,
        instructions: "updated",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
        ],
      } as never) as never;
    });
    prisma.rule.update.mockResolvedValue({ id: "rule_existing" } as never);

    const result = await updateColdEmailSettings(ctx, { prompt: "updated" });

    expect(result.prompt).toBe("updated");
    expect(result.mode).toBe("LABEL");
    // Action set not rewritten when mode is unchanged.
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
    expect(prisma.rule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "rule_existing" },
        data: { enabled: true, instructions: "updated" },
      }),
    );
  });

  it("disables existing rule when enabled=false", async () => {
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_existing") {
        return Promise.resolve({
          id: "rule_existing",
          instructions: "p",
        } as never) as never;
      }
      // Used inside getColdEmailSettings (current) and updateColdEmailSettings
      // After disable, rule.enabled = false -> mode=DISABLED.
      return Promise.resolve({
        id: "rule_existing",
        enabled: false,
        instructions: "p",
        groupId: null,
        actions: [
          { type: ActionType.LABEL, label: "Cold Emails", labelId: null },
        ],
      } as never) as never;
    });
    prisma.rule.update.mockResolvedValue({ id: "rule_existing" } as never);

    const result = await updateColdEmailSettings(ctx, { enabled: false });

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe("DISABLED");
  });

  it("switches mode rewrites the action set", async () => {
    prisma.rule.findUnique.mockImplementation((args: never) => {
      const a = args as { where?: { id?: string } };
      if (a.where?.id === "rule_existing") {
        return Promise.resolve({
          id: "rule_existing",
          instructions: null,
        } as never) as never;
      }
      return Promise.resolve({
        id: "rule_existing",
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
    prisma.rule.update.mockResolvedValue({ id: "rule_existing" } as never);
    prisma.action.deleteMany.mockResolvedValue({ count: 1 } as never);
    prisma.action.createMany.mockResolvedValue({ count: 3 } as never);

    const result = await updateColdEmailSettings(ctx, {
      mode: "ARCHIVE_AND_READ_AND_LABEL",
    });

    expect(result.mode).toBe("ARCHIVE_AND_READ_AND_LABEL");
    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: "rule_existing" },
    });
    expect(prisma.action.createMany).toHaveBeenCalledWith({
      data: [
        {
          type: ActionType.LABEL,
          label: "Cold Emails",
          ruleId: "rule_existing",
        },
        { type: ActionType.ARCHIVE, ruleId: "rule_existing" },
        { type: ActionType.MARK_READ, ruleId: "rule_existing" },
      ],
    });
  });

  it("returns empty settings without creating rule when disabling and none exists", async () => {
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await updateColdEmailSettings(ctx, { enabled: false });

    expect(result.enabled).toBe(false);
    expect(result.mode).toBe("DISABLED");
    expect(result.ruleId).toBeNull();
    expect(prisma.rule.create).not.toHaveBeenCalled();
  });
});
