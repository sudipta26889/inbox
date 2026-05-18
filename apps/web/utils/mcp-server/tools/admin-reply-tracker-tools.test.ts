import { ActionType, DraftReplyConfidence } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
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
