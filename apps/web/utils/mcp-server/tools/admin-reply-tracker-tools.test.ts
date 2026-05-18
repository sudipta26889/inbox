import {
  ActionType,
  DraftReplyConfidence,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
  adminFollowUpsList,
  adminFollowUpsUpdate,
  adminReplyTrackerGetSettings,
  adminReplyTrackerUpdateSettings,
} from "@/utils/mcp-server/tools/admin-reply-tracker-tools";
import { describe, expect, it, vi } from "vitest";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");

const mcpCtx: McpToolContext = {
  clientId: "c1",
  userId: "user-mcp-rt",
  emailAccountId: "ea-mcp-rt",
  scopes: ["admin"],
};

const ownedAccount = {
  id: mcpCtx.emailAccountId,
  draftReplyConfidence: DraftReplyConfidence.STANDARD,
  allowHiddenAiDraftLinks: false,
};

describe("admin_reply_tracker_get_settings", () => {
  it("returns ok envelope with disabled defaults", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminReplyTrackerGetSettings(mcpCtx, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toMatchObject({
        draftRepliesEnabled: false,
        draftReplyConfidence: DraftReplyConfidence.STANDARD,
      });
    }
  });

  it("returns NOT_FOUND when account not owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    const result = await adminReplyTrackerGetSettings(mcpCtx, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("admin_reply_tracker_update_settings", () => {
  it("returns VALIDATION_ERROR when no fields provided", async () => {
    const result = await adminReplyTrackerUpdateSettings(mcpCtx, {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("updates draftReplyConfidence and returns refreshed settings", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      ...ownedAccount,
      draftReplyConfidence: DraftReplyConfidence.HIGH_CONFIDENCE,
    } as never);
    prisma.emailAccount.update.mockResolvedValue({} as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const result = await adminReplyTrackerUpdateSettings(mcpCtx, {
      draftReplyConfidence: DraftReplyConfidence.HIGH_CONFIDENCE,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.draftReplyConfidence).toBe(
        DraftReplyConfidence.HIGH_CONFIDENCE,
      );
    }
  });

  it("returns NOT_FOUND when account not owned by user", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    const result = await adminReplyTrackerUpdateSettings(mcpCtx, {
      allowHiddenAiDraftLinks: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_ERROR on bad enum value", async () => {
    const result = await adminReplyTrackerUpdateSettings(mcpCtx, {
      draftReplyConfidence: "BOGUS",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("toggles draft replies on and returns enabled state", async () => {
    let ruleLookup = 0;
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.rule.findUnique.mockImplementation((async () => {
      ruleLookup++;
      if (ruleLookup === 1) return null;
      return {
        id: "rule-new",
        enabled: true,
        actions: [{ type: ActionType.DRAFT_EMAIL }],
      };
    }) as never);
    prisma.rule.create.mockResolvedValue({
      id: "rule-new",
      actions: [],
    } as never);
    prisma.action.create.mockResolvedValue({} as never);

    const result = await adminReplyTrackerUpdateSettings(mcpCtx, {
      draftRepliesEnabled: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.draftRepliesEnabled).toBe(true);
    }
  });
});

describe("admin_follow_ups_list", () => {
  it("returns ok envelope with items", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    prisma.threadTracker.findMany.mockResolvedValue([
      {
        id: "tt-1",
        threadId: "t1",
        messageId: "m1",
        sentAt: new Date(),
        type: ThreadTrackerType.AWAITING,
        resolved: false,
        followUpAppliedAt: new Date(),
        followUpDraftId: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);

    const result = await adminFollowUpsList(mcpCtx, { limit: 10 });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.items).toHaveLength(1);
  });

  it("returns VALIDATION_ERROR on out-of-range limit", async () => {
    const result = await adminFollowUpsList(mcpCtx, { limit: 9999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });

  it("returns NOT_FOUND when account not owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    const result = await adminFollowUpsList(mcpCtx, { limit: 10 });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });
});

describe("admin_follow_ups_update", () => {
  it("updates resolved", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    prisma.threadTracker.findFirst.mockResolvedValue({ id: "tt-2" } as never);
    prisma.threadTracker.update.mockResolvedValue({
      id: "tt-2",
      threadId: "t2",
      messageId: "m2",
      sentAt: new Date(),
      type: ThreadTrackerType.AWAITING,
      resolved: true,
      followUpAppliedAt: new Date(),
      followUpDraftId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const result = await adminFollowUpsUpdate(mcpCtx, {
      id: "tt-2",
      resolved: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.resolved).toBe(true);
  });

  it("returns NOT_FOUND for missing id", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null as never);

    const result = await adminFollowUpsUpdate(mcpCtx, {
      id: "nope",
      resolved: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("returns VALIDATION_ERROR when no mutable field provided", async () => {
    const result = await adminFollowUpsUpdate(mcpCtx, { id: "tt-2" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});
