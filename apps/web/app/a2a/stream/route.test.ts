import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { checkA2aRequestRateLimit } from "@/utils/a2a/rate-limit";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/a2a/auth", () => ({
  withA2aAuth: vi.fn().mockResolvedValue({
    userId: "u",
    emailAccountId: "a",
    clientId: "c",
  }),
}));
vi.mock("@/utils/a2a/rate-limit", () => ({
  checkA2aRequestRateLimit: vi.fn(),
}));

describe("GET /a2a/stream", () => {
  it("refuses a stream over the client's request budget before touching the DB", async () => {
    vi.mocked(checkA2aRequestRateLimit).mockResolvedValue({
      allowed: false,
      limit: 60,
      remaining: 0,
      resetAt: new Date(),
      retryAfter: 42,
    });

    const response = await GET(
      new Request("https://inbox.test/a2a/stream?taskId=t1"),
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    expect(prisma.a2aTask.findUnique).not.toHaveBeenCalled();
  });
});
