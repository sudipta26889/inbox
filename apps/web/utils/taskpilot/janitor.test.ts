import { describe, expect, it, vi } from "vitest";

vi.mock("@/utils/prisma", () => ({
  default: {
    taskpilotDecision: { updateMany: vi.fn() },
  },
}));
import prisma from "@/utils/prisma";
import { sweepStaleRunningDecisions } from "@/utils/taskpilot/janitor";

describe("sweepStaleRunningDecisions", () => {
  it("issues updateMany filtering RUNNING rows older than 60s", async () => {
    (prisma.taskpilotDecision.updateMany as any).mockResolvedValueOnce({
      count: 3,
    });
    const result = await sweepStaleRunningDecisions();
    expect(result.swept).toBe(3);
    const args = (prisma.taskpilotDecision.updateMany as any).mock.calls[0][0];
    expect(args.where.status).toBe("RUNNING");
    expect(args.data.status).toBe("LLM_FAILED");
    expect(args.data.errorMsg).toMatch(/janitor/);
  });
});
