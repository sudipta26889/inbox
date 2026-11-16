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
import { expectMcpData } from "@/__tests__/helpers";
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

    const data = expectMcpData(result);
    expect(data).toMatchObject({
      draftRepliesEnabled: false,
      draftReplyConfidence: DraftReplyConfidence.STANDARD,
    });
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

    const data = expectMcpData(result);
    expect(data.draftReplyConfidence).toBe(
      DraftReplyConfidence.HIGH_CONFIDENCE,
    );
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

    const data = expectMcpData(result);
    expect(data.draftRepliesEnabled).toBe(true);
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

    const data = expectMcpData(result);
    expect(data.items).toHaveLength(1);
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

    const data = expectMcpData(result);
    expect(data.resolved).toBe(true);
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

describe("admin_follow_ups_delete (destructive)", () => {
  it("dry-run when confirm omitted: returns preview, no mutation", async () => {
    const { adminFollowUpsDelete } = await import(
      "@/utils/mcp-server/tools/admin-reply-tracker-tools"
    );
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    const row = {
      id: "tt-d-1",
      threadId: "td",
      messageId: "md",
      type: ThreadTrackerType.AWAITING,
      resolved: false,
      followUpAppliedAt: new Date(),
      followUpDraftId: null,
      updatedAt: new Date("2026-01-01"),
    };
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);

    const result = await adminFollowUpsDelete(mcpCtx, { id: row.id });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.dryRun).toBe(true);
      expect(result.preview).toMatchObject({
        action: "delete_follow_up",
        followUp: { id: row.id },
        irreversible: true,
      });
    }
    expect(prisma.threadTracker.delete).not.toHaveBeenCalled();
  });

  it("confirm=true deletes the row", async () => {
    const { adminFollowUpsDelete } = await import(
      "@/utils/mcp-server/tools/admin-reply-tracker-tools"
    );
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    const row = {
      id: "tt-d-2",
      threadId: "td2",
      messageId: "md2",
      type: ThreadTrackerType.AWAITING,
      resolved: false,
      followUpAppliedAt: new Date(),
      followUpDraftId: null,
      updatedAt: new Date("2026-01-01"),
    };
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);
    prisma.threadTracker.delete.mockResolvedValue(row as never);

    const result = await adminFollowUpsDelete(mcpCtx, {
      id: row.id,
      confirm: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.dryRun).toBe(false);
    expect(prisma.threadTracker.delete).toHaveBeenCalledWith({
      where: { id: row.id },
    });
  });

  it("STALE_STATE when expectedUpdatedAt does not match", async () => {
    const { adminFollowUpsDelete } = await import(
      "@/utils/mcp-server/tools/admin-reply-tracker-tools"
    );
    const updatedAt = new Date("2026-01-01");
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    prisma.threadTracker.findFirst.mockResolvedValue({
      id: "tt-d-3",
      threadId: "t",
      messageId: "m",
      type: ThreadTrackerType.AWAITING,
      resolved: false,
      followUpAppliedAt: new Date(),
      followUpDraftId: null,
      updatedAt,
    } as never);

    const stale = new Date(updatedAt.getTime() - 1000).toISOString();
    const result = await adminFollowUpsDelete(mcpCtx, {
      id: "tt-d-3",
      confirm: true,
      expectedUpdatedAt: stale,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("STALE_STATE");
    expect(prisma.threadTracker.delete).not.toHaveBeenCalled();
  });

  it("NOT_FOUND on missing id (commit path)", async () => {
    const { adminFollowUpsDelete } = await import(
      "@/utils/mcp-server/tools/admin-reply-tracker-tools"
    );
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
    } as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null as never);

    const result = await adminFollowUpsDelete(mcpCtx, {
      id: "missing",
      confirm: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NOT_FOUND");
  });

  it("VALIDATION_ERROR when id missing", async () => {
    const { adminFollowUpsDelete } = await import(
      "@/utils/mcp-server/tools/admin-reply-tracker-tools"
    );
    const result = await adminFollowUpsDelete(mcpCtx, {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("VALIDATION_ERROR");
  });
});

describe("registry wiring", () => {
  it.each([
    "admin_reply_tracker_get_settings",
    "admin_follow_ups_list",
  ])("registers %s with admin:read scope", async (name) => {
    const { getTool, hasRequiredScope } = await import("./registry");
    const tool = getTool(name);
    expect(tool).toBeDefined();
    expect(tool!.requiredScope).toBe("admin:read");
    expect(hasRequiredScope(tool!, ["admin"])).toBe(true);
    expect(hasRequiredScope(tool!, ["email:read"])).toBe(false);
  });

  it.each([
    "admin_reply_tracker_update_settings",
    "admin_follow_ups_update",
    "admin_follow_ups_delete",
  ])("registers %s with admin:write scope", async (name) => {
    const { getTool, hasRequiredScope } = await import("./registry");
    const tool = getTool(name);
    expect(tool).toBeDefined();
    expect(tool!.requiredScope).toBe("admin:write");
    expect(hasRequiredScope(tool!, ["admin"])).toBe(true);
    expect(hasRequiredScope(tool!, ["email:read"])).toBe(false);
  });

  it("admin_follow_ups_delete description mentions destructive + confirm", async () => {
    const { getTool } = await import("./registry");
    const tool = getTool("admin_follow_ups_delete")!;
    expect(tool.description?.toLowerCase()).toContain("destructive");
    expect(tool.description?.toLowerCase()).toContain("confirm");
  });

  it("end-to-end: handler resolved via registry executes against mocked DB", async () => {
    const { MCP_TOOLS } = await import("./registry");
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: mcpCtx.emailAccountId,
      draftReplyConfidence: DraftReplyConfidence.STANDARD,
      allowHiddenAiDraftLinks: false,
    } as never);
    prisma.rule.findUnique.mockResolvedValue(null as never);

    const tool = MCP_TOOLS.admin_reply_tracker_get_settings!;
    const result = (await tool.handler(mcpCtx, {})) as { ok: boolean };
    expect(result.ok).toBe(true);
  });
});
