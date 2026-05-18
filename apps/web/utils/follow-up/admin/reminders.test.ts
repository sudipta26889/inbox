import { ThreadTrackerType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import {
  deleteFollowUp,
  listFollowUps,
  previewDeleteFollowUp,
  updateFollowUp,
} from "@/utils/follow-up/admin/reminders";
import { NotFoundError, StaleStateError } from "@/utils/mcp-server/errors";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma");

const ctx = { userId: "user-fu-1", emailAccountId: "ea-fu-1" };

const ownedAccount = { id: ctx.emailAccountId };

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: `t-${Math.random().toString(36).slice(2, 8)}`,
    threadId: "thread-1",
    messageId: "msg-1",
    sentAt: new Date("2026-01-01"),
    type: ThreadTrackerType.AWAITING,
    resolved: false,
    followUpAppliedAt: new Date("2026-01-02"),
    followUpDraftId: null,
    createdAt: new Date("2026-01-01"),
    updatedAt: new Date("2026-01-02"),
    ...overrides,
  };
}

describe("listFollowUps", () => {
  it("returns follow-ups for the account", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const a = makeRow();
    const b = makeRow();
    prisma.threadTracker.findMany.mockResolvedValue([b, a] as never);

    const result = await listFollowUps(ctx, { appliedOnly: true, limit: 50 });

    expect(result.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect(result.nextCursor).toBeNull();
    expect(result.count).toBe(2);
  });

  it("filters by followUpAppliedAt when appliedOnly=true", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findMany.mockResolvedValue([] as never);

    await listFollowUps(ctx, { appliedOnly: true, limit: 50 });

    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccountId: ctx.emailAccountId,
          followUpAppliedAt: { not: null },
        }),
      }),
    );
  });

  it("does not filter by followUpAppliedAt when appliedOnly=false", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findMany.mockResolvedValue([] as never);

    await listFollowUps(ctx, { appliedOnly: false, limit: 50 });

    const call = (
      prisma.threadTracker.findMany as unknown as {
        mock: { calls: unknown[][] };
      }
    ).mock.calls[0][0] as { where: Record<string, unknown> };
    expect(call.where).not.toHaveProperty("followUpAppliedAt");
  });

  it("filters by resolved", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findMany.mockResolvedValue([] as never);

    await listFollowUps(ctx, {
      appliedOnly: true,
      resolved: false,
      limit: 50,
    });

    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ resolved: false }),
      }),
    );
  });

  it("filters by type", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findMany.mockResolvedValue([] as never);

    await listFollowUps(ctx, {
      appliedOnly: true,
      type: ThreadTrackerType.NEEDS_REPLY,
      limit: 50,
    });

    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: ThreadTrackerType.NEEDS_REPLY,
        }),
      }),
    );
  });

  it("paginates: returns nextCursor when more results exist", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const rows = [makeRow(), makeRow(), makeRow()];
    prisma.threadTracker.findMany.mockResolvedValue(rows as never);

    const result = await listFollowUps(ctx, { appliedOnly: true, limit: 2 });

    expect(result.items).toHaveLength(2);
    expect(result.nextCursor).toBe(rows[1].id);
  });

  it("uses cursor when provided", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findMany.mockResolvedValue([] as never);

    await listFollowUps(ctx, {
      appliedOnly: true,
      limit: 10,
      cursor: "cursor-xyz",
    });

    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        cursor: { id: "cursor-xyz" },
        skip: 1,
      }),
    );
  });

  it("throws NotFoundError when account is not owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      listFollowUps(
        { userId: "other-u", emailAccountId: ctx.emailAccountId },
        { appliedOnly: true, limit: 50 },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("updateFollowUp", () => {
  it("updates resolved flag", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-1", resolved: false });
    prisma.threadTracker.findFirst.mockResolvedValue({ id: row.id } as never);
    prisma.threadTracker.update.mockResolvedValue({
      ...row,
      resolved: true,
    } as never);

    const updated = await updateFollowUp(ctx, { id: row.id, resolved: true });

    expect(updated.resolved).toBe(true);
    expect(prisma.threadTracker.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: row.id },
        data: { resolved: true },
      }),
    );
  });

  it("updates followUpAppliedAt", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-2" });
    prisma.threadTracker.findFirst.mockResolvedValue({ id: row.id } as never);
    const newDate = new Date("2030-01-01");
    prisma.threadTracker.update.mockResolvedValue({
      ...row,
      followUpAppliedAt: newDate,
    } as never);

    const updated = await updateFollowUp(ctx, {
      id: row.id,
      followUpAppliedAt: newDate,
    });

    expect(updated.followUpAppliedAt).toEqual(newDate);
  });

  it("clears followUpDraftId when set to null", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-3", followUpDraftId: "draft-x" });
    prisma.threadTracker.findFirst.mockResolvedValue({ id: row.id } as never);
    prisma.threadTracker.update.mockResolvedValue({
      ...row,
      followUpDraftId: null,
    } as never);

    const updated = await updateFollowUp(ctx, {
      id: row.id,
      followUpDraftId: null,
    });

    expect(updated.followUpDraftId).toBeNull();
  });

  it("throws NotFoundError when tracker belongs to a different account", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null as never);

    await expect(
      updateFollowUp(ctx, { id: "foreign-id", resolved: true }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when account is not owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      updateFollowUp(
        { userId: "other-u", emailAccountId: ctx.emailAccountId },
        { id: "any", resolved: true },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("deleteFollowUp + previewDeleteFollowUp", () => {
  it("deletes the tracker row when owned", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-d-1" });
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);
    prisma.threadTracker.delete.mockResolvedValue(row as never);

    const result = await deleteFollowUp(ctx, row.id);

    expect(result).toEqual({ id: row.id, threadId: row.threadId });
    expect(prisma.threadTracker.delete).toHaveBeenCalledWith({
      where: { id: row.id },
    });
  });

  it("throws NotFoundError when the row is missing", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    prisma.threadTracker.findFirst.mockResolvedValue(null as never);

    await expect(deleteFollowUp(ctx, "missing-id")).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("returns preview info for dry-run without deleting", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-p-1" });
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);

    const preview = await previewDeleteFollowUp(ctx, row.id);

    expect(preview).toMatchObject({
      action: "delete_follow_up",
      followUp: { id: row.id, threadId: row.threadId },
      irreversible: true,
    });
    expect(prisma.threadTracker.delete).not.toHaveBeenCalled();
  });

  it("preview includes hasProviderDraft when followUpDraftId set", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const row = makeRow({ id: "tt-p-2", followUpDraftId: "draft-z" });
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);

    const preview = await previewDeleteFollowUp(ctx, row.id);

    expect(preview.willCascade).toEqual({ hasProviderDraft: true });
  });

  it("throws StaleStateError when expectedUpdatedAt mismatch", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const updatedAt = new Date("2026-02-01");
    const row = makeRow({ id: "tt-s-1", updatedAt });
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);

    const stale = new Date(updatedAt.getTime() - 1000);
    await expect(
      deleteFollowUp(ctx, row.id, { expectedUpdatedAt: stale }),
    ).rejects.toBeInstanceOf(StaleStateError);
    expect(prisma.threadTracker.delete).not.toHaveBeenCalled();
  });

  it("succeeds when expectedUpdatedAt matches", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(ownedAccount as never);
    const updatedAt = new Date("2026-02-01");
    const row = makeRow({ id: "tt-s-2", updatedAt });
    prisma.threadTracker.findFirst.mockResolvedValue(row as never);
    prisma.threadTracker.delete.mockResolvedValue(row as never);

    const result = await deleteFollowUp(ctx, row.id, {
      expectedUpdatedAt: new Date(updatedAt.getTime()),
    });

    expect(result.id).toBe(row.id);
  });
});
