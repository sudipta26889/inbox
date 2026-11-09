import { describe, it, expect, vi, beforeEach } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { Prisma } from "@/generated/prisma/client";
import { createScopedLogger } from "@/utils/logger";
import { getMockMessage } from "@/__tests__/helpers";
import { trackSentDraftStatus } from "./draft-tracking";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));
vi.mock("@/utils/similarity-score", () => ({
  calculateSimilarity: vi.fn().mockReturnValue(0.9),
}));

const logger = createScopedLogger("test");

describe("trackSentDraftStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.executedAction.findFirst).mockResolvedValue({
      id: "action-1",
      draftId: "draft-1",
      content: "Thanks for reaching out.",
    } as any);
  });

  function track(draftStillExists: boolean) {
    return trackSentDraftStatus({
      emailAccountId: "account-1",
      message: getMockMessage({ id: "sent-1", threadId: "thread-1" }),
      provider: {
        getDraft: vi.fn().mockResolvedValue(draftStillExists ? {} : null),
      } as any,
      logger,
    });
  }

  it.each([
    ["the draft was sent", false],
    ["the draft still exists", true],
  ])(
    "treats a send log recorded concurrently as already tracked when %s",
    async (_name, draftStillExists) => {
      vi.mocked(prisma.$transaction).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
          code: "P2002",
          clientVersion: "7.8.0",
          meta: { target: ["executedActionId"] },
        }),
      );

      await expect(track(draftStillExists)).resolves.toBeUndefined();
    },
  );

  it("still throws other database errors", async () => {
    vi.mocked(prisma.$transaction).mockRejectedValue(new Error("db down"));

    await expect(track(false)).rejects.toThrow("db down");
  });

  it("records the send log and marks the draft sent", async () => {
    vi.mocked(prisma.$transaction).mockResolvedValue([{ id: "log-1" }, {}]);

    await track(false);

    expect(prisma.executedAction.update).toHaveBeenCalledWith({
      where: { id: "action-1" },
      data: { wasDraftSent: true },
    });
  });
});
