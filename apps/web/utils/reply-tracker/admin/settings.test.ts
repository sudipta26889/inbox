import {
  ActionType,
  DraftReplyConfidence,
  SystemType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { NotFoundError } from "@/utils/mcp-server/errors";
import {
  getReplyTrackerSettings,
  updateReplyTrackerSettings,
} from "@/utils/reply-tracker/admin/settings";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma");

const ctx = { userId: "user-rt-1", emailAccountId: "ea-rt-1" };

const accountRow = {
  id: ctx.emailAccountId,
  draftReplyConfidence: DraftReplyConfidence.STANDARD,
  allowHiddenAiDraftLinks: false,
};

describe("getReplyTrackerSettings", () => {
  it("returns draftRepliesEnabled=false when no TO_REPLY rule exists", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await getReplyTrackerSettings(ctx, {});

    expect(result).toMatchObject({
      draftRepliesEnabled: false,
      draftReplyConfidence: DraftReplyConfidence.STANDARD,
      allowHiddenAiDraftLinks: false,
      toReplyRuleId: null,
    });
  });

  it("returns draftRepliesEnabled=true when TO_REPLY rule exists with DRAFT_EMAIL action", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValue({
      id: "rule_1",
      enabled: true,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);

    const result = await getReplyTrackerSettings(ctx, {});

    expect(result.draftRepliesEnabled).toBe(true);
    expect(result.toReplyRuleId).toBe("rule_1");
  });

  it("returns draftRepliesEnabled=false when rule exists but is disabled", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValue({
      id: "rule_1",
      enabled: false,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);

    const result = await getReplyTrackerSettings(ctx, {});

    expect(result.draftRepliesEnabled).toBe(false);
  });

  it("returns draftRepliesEnabled=false when rule has no DRAFT_EMAIL action", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValue({
      id: "rule_1",
      enabled: true,
      actions: [{ type: ActionType.LABEL }],
    } as never);

    const result = await getReplyTrackerSettings(ctx, {});

    expect(result.draftRepliesEnabled).toBe(false);
  });

  it("throws NotFoundError when emailAccountId does not exist", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      getReplyTrackerSettings(
        { userId: ctx.userId, emailAccountId: "missing" },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when account belongs to a different user", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      getReplyTrackerSettings(
        { userId: "other-user", emailAccountId: ctx.emailAccountId },
        {},
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateReplyTrackerSettings", () => {
  it("updates draftReplyConfidence", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.emailAccount.update.mockResolvedValue({} as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    await updateReplyTrackerSettings(ctx, {
      draftReplyConfidence: DraftReplyConfidence.HIGH_CONFIDENCE,
    });

    expect(prisma.emailAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: ctx.emailAccountId },
        data: { draftReplyConfidence: DraftReplyConfidence.HIGH_CONFIDENCE },
      }),
    );
  });

  it("updates allowHiddenAiDraftLinks", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.emailAccount.update.mockResolvedValue({} as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    await updateReplyTrackerSettings(ctx, { allowHiddenAiDraftLinks: true });

    expect(prisma.emailAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { allowHiddenAiDraftLinks: true },
      }),
    );
  });

  it("toggles draft replies on by creating TO_REPLY rule + DRAFT_EMAIL action", async () => {
    let ruleLookup = 0;
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockImplementation((async () => {
      ruleLookup++;
      // First call (inside setDraftRepliesEnabled) returns null so we create.
      if (ruleLookup === 1) return null;
      // Subsequent get for refreshed settings returns the new rule with action.
      return {
        id: "new-rule",
        enabled: true,
        actions: [{ type: ActionType.DRAFT_EMAIL }],
      };
    }) as never);
    prisma.rule.create.mockResolvedValue({
      id: "new-rule",
      actions: [],
    } as never);
    prisma.action.create.mockResolvedValue({} as never);

    const result = await updateReplyTrackerSettings(ctx, {
      draftRepliesEnabled: true,
    });

    expect(result.draftRepliesEnabled).toBe(true);
    expect(prisma.rule.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          emailAccountId: ctx.emailAccountId,
          systemType: SystemType.TO_REPLY,
          enabled: true,
        }),
      }),
    );
    expect(prisma.action.create).toHaveBeenCalledWith({
      data: { ruleId: "new-rule", type: ActionType.DRAFT_EMAIL },
    });
  });

  it("toggles draft replies on by adding DRAFT_EMAIL to existing rule without action", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValueOnce({
      id: "rule_e",
      enabled: true,
      actions: [{ type: ActionType.LABEL }],
    } as never);
    // Second call (inside getReplyTrackerSettings) after action create.
    prisma.rule.findUnique.mockResolvedValueOnce({
      id: "rule_e",
      enabled: true,
      actions: [{ type: ActionType.LABEL }, { type: ActionType.DRAFT_EMAIL }],
    } as never);
    prisma.action.create.mockResolvedValue({} as never);

    const result = await updateReplyTrackerSettings(ctx, {
      draftRepliesEnabled: true,
    });

    expect(result.draftRepliesEnabled).toBe(true);
    expect(prisma.action.create).toHaveBeenCalledWith({
      data: { ruleId: "rule_e", type: ActionType.DRAFT_EMAIL },
    });
    expect(prisma.rule.create).not.toHaveBeenCalled();
  });

  it("toggles draft replies off by removing DRAFT_EMAIL action", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValueOnce({
      id: "rule_e",
      enabled: true,
      actions: [{ type: ActionType.DRAFT_EMAIL }],
    } as never);
    prisma.rule.findUnique.mockResolvedValueOnce({
      id: "rule_e",
      enabled: true,
      actions: [],
    } as never);
    prisma.action.deleteMany.mockResolvedValue({ count: 1 } as never);

    const result = await updateReplyTrackerSettings(ctx, {
      draftRepliesEnabled: false,
    });

    expect(result.draftRepliesEnabled).toBe(false);
    expect(prisma.action.deleteMany).toHaveBeenCalledWith({
      where: { ruleId: "rule_e", type: ActionType.DRAFT_EMAIL },
    });
  });

  it("disabling draft replies when no rule exists is a no-op", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(accountRow as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await updateReplyTrackerSettings(ctx, {
      draftRepliesEnabled: false,
    });

    expect(result.draftRepliesEnabled).toBe(false);
    expect(prisma.rule.create).not.toHaveBeenCalled();
    expect(prisma.action.create).not.toHaveBeenCalled();
    expect(prisma.action.deleteMany).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when account is not owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      updateReplyTrackerSettings(
        { userId: "other-user", emailAccountId: ctx.emailAccountId },
        { allowHiddenAiDraftLinks: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
