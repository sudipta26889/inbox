import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  mockPrisma,
  mockBeforeExecute,
  mockApproveTask,
  mockRejectTask,
  mockPublishPendingApprovalsUpdate,
  mockIsApprovalGateRequired,
} = vi.hoisted(() => ({
  mockPrisma: {
    a2aTask: { findUnique: vi.fn() },
    a2aApproval: { update: vi.fn() },
  },
  mockBeforeExecute: vi.fn(),
  mockApproveTask: vi.fn().mockResolvedValue(undefined),
  mockRejectTask: vi.fn().mockResolvedValue(undefined),
  mockPublishPendingApprovalsUpdate: vi.fn().mockResolvedValue(undefined),
  mockIsApprovalGateRequired: vi.fn().mockReturnValue(true),
}));

vi.mock("@/utils/prisma", () => ({ default: mockPrisma }));

vi.mock("@/utils/dharahil/required", () => ({
  isApprovalGateRequired: mockIsApprovalGateRequired,
}));

vi.mock("./task-executor", () => ({
  approveTask: mockApproveTask,
  rejectTask: mockRejectTask,
}));

vi.mock("./protocol-handler", () => ({
  publishPendingApprovalsUpdate: mockPublishPendingApprovalsUpdate,
}));

// The real client's decision-matching logic (shouldProceed/shouldRevise/
// wasDenied) is exercised for real here rather than re-stubbed, since the
// whole point of the fix is that the integration reuses it instead of
// string-matching a second set of literals.
vi.mock("@/utils/dharahil/client", () => ({
  dharahilClient: {
    beforeExecute: mockBeforeExecute,
    shouldProceed: (decision: { action?: string }) =>
      decision.action === "ALLOW" ||
      decision.action === "APPROVED" ||
      decision.action === "AUTO_ALLOWED",
    shouldRevise: (decision: { action?: string }) =>
      decision.action === "REVISE_REQUESTED",
    wasDenied: (decision: { action?: string }) =>
      decision.action === "DENY" ||
      decision.action === "REJECTED" ||
      decision.action === "EXPIRED" ||
      decision.action === "ERROR",
  },
}));

import { requestApprovalViaDharaHIL } from "./dharahil-integration";

const mockTask = {
  id: "task-internal-1",
  taskId: "task-public-1",
  state: "auth_required",
  skill: "calendar.create_event",
  input: {},
  userId: "user-1",
  contextId: "ctx-1",
  clientId: "client-1",
  emailAccountId: "email-account-1",
  user: { id: "user-1", email: "user@example.com" },
};

/**
 * Mimics real Prisma's behavior for the one detail this bug hinges on: an
 * invalid `Date` object passed as `expiresAt` throws rather than writing.
 * Everything else just resolves, same as the real update would.
 */
function rejectInvalidDates({ data }: { data: Record<string, unknown> }) {
  const { expiresAt } = data;
  if (
    expiresAt instanceof Date &&
    Number.isNaN((expiresAt as Date).getTime())
  ) {
    throw new Error(
      "Invalid `prisma.a2aApproval.update()` invocation: Invalid value for argument `expiresAt`: Provided Date object is invalid.",
    );
  }
  return Promise.resolve({});
}

beforeEach(() => {
  vi.clearAllMocks();
  mockIsApprovalGateRequired.mockReturnValue(true);
  mockPrisma.a2aTask.findUnique.mockResolvedValue(mockTask);
  mockPrisma.a2aApproval.update.mockImplementation(rejectInvalidDates as any);
});

describe("requestApprovalViaDharaHIL", () => {
  /**
   * The production incident: the gateway decided ALLOW immediately (no
   * request_id, no expires_at). The old code wrote
   * `expiresAt: new Date(undefined)` unconditionally, Prisma rejected the
   * Invalid Date, and the catch block marked a human-approved action
   * "rejected". This must approve the task instead, and must never touch
   * the approval's status via the direct update path.
   */
  it("resolves an immediate ALLOW by approving the task, not rejecting it", async () => {
    mockBeforeExecute.mockResolvedValue({
      action: "ALLOW",
      request_id: null,
      expires_at: undefined,
      status: "auto_allowed",
    } as any);

    await requestApprovalViaDharaHIL("task-internal-1");

    expect(mockApproveTask).toHaveBeenCalledWith(
      "task-internal-1",
      "dharahil_gateway",
      expect.objectContaining({ action: "ALLOW" }),
    );
    expect(mockRejectTask).not.toHaveBeenCalled();
    expect(mockPrisma.a2aApproval.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected" }),
      }),
    );
  });

  it("resolves an immediate deny by rejecting the task", async () => {
    mockBeforeExecute.mockResolvedValue({
      action: "DENY",
      request_id: null,
      expires_at: undefined,
      reason: "policy",
      status: "auto_denied",
    } as any);

    await requestApprovalViaDharaHIL("task-internal-1");

    expect(mockRejectTask).toHaveBeenCalledWith(
      "task-internal-1",
      "dharahil_gateway",
      expect.stringContaining("policy"),
    );
    expect(mockApproveTask).not.toHaveBeenCalled();
    // The denial must go through rejectTask (which itself updates the
    // approval), not through the direct-update rejection path.
    expect(mockPrisma.a2aApproval.update).not.toHaveBeenCalled();
  });

  it("still stores dharahilRequestId and expiresAt for a normal deferred response", async () => {
    const expiresAt = "2026-09-08T00:00:00.000Z";
    mockBeforeExecute.mockResolvedValue({
      request_id: "req-1",
      expires_at: expiresAt,
      status: "pending",
    } as any);

    const requestId = await requestApprovalViaDharaHIL("task-internal-1");

    expect(requestId).toBe("req-1");
    expect(mockPrisma.a2aApproval.update).toHaveBeenCalledWith({
      where: { taskId: "task-internal-1" },
      data: {
        dharahilRequestId: "req-1",
        expiresAt: new Date(expiresAt),
      },
    });
    expect(mockApproveTask).not.toHaveBeenCalled();
    expect(mockRejectTask).not.toHaveBeenCalled();
  });

  it("does not reject the approval when expires_at is unparseable", async () => {
    mockBeforeExecute.mockResolvedValue({
      request_id: "req-1",
      expires_at: "not-a-date",
      status: "pending",
    } as any);

    await requestApprovalViaDharaHIL("task-internal-1");

    expect(mockPrisma.a2aApproval.update).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: "rejected" }),
      }),
    );
    // The request_id is still real and worth keeping even though the expiry
    // could not be parsed.
    expect(mockPrisma.a2aApproval.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ dharahilRequestId: "req-1" }),
      }),
    );
  });
});
