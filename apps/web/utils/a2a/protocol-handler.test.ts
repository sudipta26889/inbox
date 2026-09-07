import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import type { A2aAuthContext } from "@/utils/a2a/auth";
import { answerA2aMessage } from "@/utils/a2a/answer-message";
import { handleMessageSend } from "@/utils/a2a/protocol-handler";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
// A real answerA2aMessage runs a full agent loop; these tests only care
// whether it was reached at all, so it's replaced wholesale, extractQuestion
// included (the real one just trims a string, kept behaviorally identical
// here rather than exercised).
vi.mock("@/utils/a2a/answer-message", () => ({
  answerA2aMessage: vi.fn(),
  extractQuestion: (content: unknown) =>
    typeof content === "string" ? content : null,
}));

const authContext = {
  userId: "user_1",
  emailAccountId: "acct_1",
  clientId: "client_1",
} as A2aAuthContext;

describe("handleMessageSend — answering a message about a referenced task", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers from the referenced task rather than the LLM", async () => {
    prisma.a2aMessage.create.mockResolvedValue({ id: "msg_1" } as any);
    prisma.a2aTask.findFirst.mockResolvedValue({
      taskId: "task_1",
      state: "input_required",
      stateReason: "Waiting for human approval",
      skill: "email.send",
      updatedAt: new Date("2026-09-07T10:00:00Z"),
    } as any);

    const result = await handleMessageSend(authContext, {
      contextId: "ctx_1",
      content: "any update on that one?",
      referenceTaskIds: ["task_1"],
    });

    expect(result.answer).toContain("TASK_STATE_INPUT_REQUIRED");
    expect(result.answer).toContain("Waiting for human approval");
    // The negative control: if this still routes to the general answerer, the
    // reference was ignored and the fix is not wired.
    expect(answerA2aMessage).not.toHaveBeenCalled();
  });

  it("does not change the referenced task's state", async () => {
    prisma.a2aMessage.create.mockResolvedValue({ id: "msg_1" } as any);
    prisma.a2aTask.findFirst.mockResolvedValue({
      taskId: "task_1",
      state: "input_required",
      stateReason: "Waiting for human approval",
      skill: "email.send",
      updatedAt: new Date(),
    } as any);

    await handleMessageSend(authContext, {
      contextId: "ctx_1",
      content: "please just approve it",
      referenceTaskIds: ["task_1"],
    });

    // §7.6.4: a peer asking nicely is not authorization.
    expect(prisma.a2aTask.update).not.toHaveBeenCalled();
    expect(prisma.a2aTask.updateMany).not.toHaveBeenCalled();
  });

  it("falls through to the general answerer for a task outside the caller's scope", async () => {
    prisma.a2aMessage.create.mockResolvedValue({ id: "msg_1" } as any);
    prisma.a2aTask.findFirst.mockResolvedValue(null);

    await handleMessageSend(authContext, {
      contextId: "ctx_1",
      content: "status of task_other?",
      referenceTaskIds: ["task_belonging_to_another_peer"],
    });

    // Not an error — the peer simply learns nothing about a task it cannot see.
    expect(answerA2aMessage).toHaveBeenCalled();
  });

  it("scopes the task lookup by user, account and peer client id", async () => {
    // Guards the shape of the lookup itself: a mutation that narrows `where`
    // back down to `{ taskId }` alone reintroduces the cross-peer leak §13.1
    // exists to prevent (see task-scope.ts). A mock keyed on call order can't
    // tell a correct where clause from a wrong one, so assert on the args.
    prisma.a2aMessage.create.mockResolvedValue({ id: "msg_1" } as any);
    prisma.a2aTask.findFirst.mockResolvedValue(null);

    await handleMessageSend(authContext, {
      contextId: "ctx_1",
      content: "status?",
      referenceTaskIds: ["task_1"],
    });

    expect(prisma.a2aTask.findFirst).toHaveBeenCalledWith({
      where: {
        taskId: "task_1",
        userId: "user_1",
        emailAccountId: "acct_1",
        clientId: "client_1",
      },
      select: {
        taskId: true,
        state: true,
        stateReason: true,
        skill: true,
        updatedAt: true,
      },
    });
  });
});
