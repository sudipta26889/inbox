import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { createEmailProvider } from "@/utils/email/provider";
import { aiAnalyzeWritingStyle } from "@/utils/ai/knowledge/writing-style";
import { SafeError } from "@/utils/error";
import { analyzeWritingStyleAction } from "@/utils/actions/assess";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/email/provider");
vi.mock("@/utils/ai/knowledge/writing-style");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(), set: vi.fn() },
}));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({ user: { id: "u1", email: "owner@example.com" } })),
}));

describe("analyzeWritingStyleAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(redis.get).mockResolvedValue(null);
    vi.mocked(redis.set).mockResolvedValue("OK" as any);
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "ea_1",
      email: "owner@example.com",
      writingStyle: null,
      account: { userId: "u1", provider: "google" },
      user: {},
    } as any);
    vi.mocked(createEmailProvider).mockResolvedValue({
      getSentMessages: vi.fn().mockResolvedValue([]),
    } as any);
  });

  it("records a 24h cooldown when the analysis fails", async () => {
    vi.mocked(aiAnalyzeWritingStyle).mockRejectedValue(new Error("no match"));

    await analyzeWritingStyleAction("ea_1" as any);

    expect(redis.set).toHaveBeenCalledWith(
      "writing-style:failed:ea_1",
      "true",
      { ex: 24 * 60 * 60 },
    );
  });

  it("does not analyse again while the cooldown is active", async () => {
    vi.mocked(redis.get).mockResolvedValue("true");

    await analyzeWritingStyleAction("ea_1" as any);

    expect(aiAnalyzeWritingStyle).not.toHaveBeenCalled();
  });

  it("does not set a cooldown after a successful analysis", async () => {
    vi.mocked(aiAnalyzeWritingStyle).mockResolvedValue({
      typicalLength: "short",
      formality: "informal",
      commonGreeting: "Hi",
      notableTraits: [],
      examples: [],
    });

    await analyzeWritingStyleAction("ea_1" as any);

    expect(prisma.emailAccount.update).toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it("still analyses when Redis is unavailable", async () => {
    vi.mocked(redis.get).mockRejectedValue(new Error("redis down"));
    vi.mocked(aiAnalyzeWritingStyle).mockResolvedValue({
      typicalLength: "short",
      formality: "informal",
      commonGreeting: "Hi",
      notableTraits: [],
      examples: [],
    });

    await analyzeWritingStyleAction("ea_1" as any);

    expect(aiAnalyzeWritingStyle).toHaveBeenCalled();
  });

  it("rethrows the original error when recording the cooldown fails", async () => {
    vi.mocked(aiAnalyzeWritingStyle).mockRejectedValue(
      new SafeError("original failure"),
    );
    vi.mocked(redis.set).mockRejectedValue(new Error("redis down"));

    const result = await analyzeWritingStyleAction("ea_1" as any);

    expect(result?.serverError).toBe("original failure");
    expect(redis.set).toHaveBeenCalled();
  });
});
