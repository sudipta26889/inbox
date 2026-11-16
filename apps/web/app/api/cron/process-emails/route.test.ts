import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { GET } from "./route";

const { CRON_SECRET, mockEnv } = vi.hoisted(() => ({
  CRON_SECRET: "cron-secret",
  mockEnv: {} as Record<string, unknown>,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: vi.fn().mockResolvedValue("internal-fallback"),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  Object.assign(mockEnv, actual.env, { CRON_SECRET });
  return { env: mockEnv };
});

describe("GET /api/cron/process-emails", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;
  });

  it("enqueues every connected mailbox when billing is bypassed", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "ea-1" },
      { id: "ea-2" },
    ] as never);

    const response = await GET(
      new NextRequest("http://web:5500/api/cron/process-emails", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ total: 2, queued: 2, failed: 0 });
    const { where } = prisma.emailAccount.findMany.mock.calls[0][0]!;
    expect(where).toEqual({
      account: {
        disconnectedAt: null,
        provider: { in: ["google", "microsoft"] },
      },
    });
    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.objectContaining({
        body: { emailAccountId: "ea-2" },
        qstash: expect.objectContaining({ path: "/api/process-emails" }),
      }),
    );
  });

  it("keeps the premium filter, so an image built without the bypass enqueues nothing", async () => {
    mockEnv.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = undefined;
    prisma.emailAccount.findMany.mockResolvedValue([] as never);

    const response = await GET(
      new NextRequest("http://web:5500/api/cron/process-emails", {
        headers: { authorization: `Bearer ${CRON_SECRET}` },
      }),
      { params: Promise.resolve({}) },
    );

    expect(await response.json()).toEqual({ total: 0, queued: 0, failed: 0 });
    const { where } = prisma.emailAccount.findMany.mock.calls[0][0]!;
    expect(where).toHaveProperty("user.premium");
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });
});
