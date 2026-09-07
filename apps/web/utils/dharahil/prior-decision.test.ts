import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: { a2aApproval: { updateMany: vi.fn() } },
}));
vi.mock("@/utils/prisma", () => ({ default: mockPrisma }));

import { createScopedLogger } from "@/utils/logger";
import { canonicalActionKey, consumeApprovedDecision } from "./prior-decision";

const logger = createScopedLogger("prior-decision-test");
const base = {
  userId: "u1",
  emailAccountId: "acct-1",
  operation: "create_calendar_event",
};
const key = (args: unknown) => canonicalActionKey({ ...base, args });

describe("canonical action key", () => {
  it("gives the same key to the same action asked twice", () => {
    const args = { title: "Standup", startTime: "2026-09-08T09:00:00Z" };

    expect(key(args)).toBe(key({ ...args }));
  });

  // The A2A layer and the tool build the object independently; key order is an
  // artifact of construction, not part of the action.
  it("ignores the order the arguments were written in", () => {
    expect(key({ title: "Standup", location: "Zoom" })).toBe(
      key({ location: "Zoom", title: "Standup" }),
    );
  });

  // Attendee lists are sets. Same people, same meeting.
  it("ignores the order of an attendee list", () => {
    expect(key({ attendees: ["b@x.com", "a@x.com"] })).toBe(
      key({ attendees: ["a@x.com", "b@x.com"] }),
    );
  });

  it("ignores absent optional fields", () => {
    expect(key({ title: "Standup", location: undefined })).toBe(
      key({ title: "Standup" }),
    );
  });

  /**
   * The direction that matters. A key that differs when it shouldn't costs an
   * extra prompt; a key that MATCHES when it shouldn't skips one, letting an
   * approval for one event authorize a different one. These must never collide.
   */
  it("separates actions that differ in any way a human would care about", () => {
    const original = { title: "Standup", startTime: "2026-09-08T09:00:00Z" };

    expect(key({ ...original, title: "Board meeting" })).not.toBe(
      key(original),
    );
    expect(key({ ...original, startTime: "2026-09-09T09:00:00Z" })).not.toBe(
      key(original),
    );
    expect(key({ ...original, attendees: ["ceo@x.com"] })).not.toBe(
      key(original),
    );
  });

  it("separates the same action requested by a different person or account", () => {
    const args = { title: "Standup" };

    expect(canonicalActionKey({ ...base, userId: "u2", args })).not.toBe(
      key(args),
    );
    expect(
      canonicalActionKey({ ...base, emailAccountId: "acct-2", args }),
    ).not.toBe(key(args));
  });

  it("separates different operations carrying identical arguments", () => {
    const args = { title: "Standup" };

    expect(
      canonicalActionKey({ ...base, operation: "delete_calendar_event", args }),
    ).not.toBe(key(args));
  });
});

describe("consuming a prior decision", () => {
  beforeEach(() => vi.clearAllMocks());

  it("proceeds when a human already approved this exact action", async () => {
    mockPrisma.a2aApproval.updateMany.mockResolvedValue({ count: 1 });

    await expect(
      consumeApprovedDecision({ actionKey: "abc", logger }),
    ).resolves.toBe(true);
  });

  it("asks when nothing has been approved", async () => {
    mockPrisma.a2aApproval.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      consumeApprovedDecision({ actionKey: "abc", logger }),
    ).resolves.toBe(false);
  });

  /**
   * One approval authorizes one execution. Without single-use consumption a
   * retried task — or a peer resubmitting an identical event — would inherit
   * the earlier "yes" and write again unasked.
   */
  it("only accepts decisions that are approved and not already spent", async () => {
    mockPrisma.a2aApproval.updateMany.mockResolvedValue({ count: 1 });

    await consumeApprovedDecision({ actionKey: "abc", logger });

    expect(mockPrisma.a2aApproval.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        actionKey: "abc",
        status: "approved",
        consumedAt: null,
      }),
      data: { consumedAt: expect.any(Date) },
    });
  });

  /**
   * A decision only counts while the request it belongs to is still live.
   *
   * Verified against production before this clause existed: a peer could ask
   * for an event, cancel it, let the human approve anyway, then resubmit the
   * identical event and inherit that approval — writing with no prompt at all.
   */
  it("ignores a decision whose task has already finished", async () => {
    mockPrisma.a2aApproval.updateMany.mockResolvedValue({ count: 1 });

    await consumeApprovedDecision({ actionKey: "abc", logger });

    const where = mockPrisma.a2aApproval.updateMany.mock.calls[0][0].where;

    expect(where.task).toEqual({
      state: { notIn: ["completed", "failed", "canceled", "rejected"] },
    });
  });

  it("marks the decision spent in the same statement that claims it", async () => {
    mockPrisma.a2aApproval.updateMany.mockResolvedValue({ count: 1 });

    await consumeApprovedDecision({ actionKey: "abc", logger });

    // One conditional UPDATE, not a read followed by a write: a read-then-write
    // lets two concurrent executions both see an unspent approval.
    expect(mockPrisma.a2aApproval.updateMany).toHaveBeenCalledTimes(1);
  });
});
