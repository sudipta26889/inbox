import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { GET } from "./route";

const { CRON_SECRET } = vi.hoisted(() => ({ CRON_SECRET: "cron-secret" }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: vi.fn().mockResolvedValue("internal-fallback"),
}));
// Polling must not hinge on a build arg: run with the premium bypass unset.
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    env: {
      ...actual.env,
      CRON_SECRET,
      NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: undefined,
    },
  };
});

describe("GET /api/cron/process-emails", () => {
  beforeEach(() => vi.clearAllMocks());

  it("enqueues every connected mailbox, with no premium filter", async () => {
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
});
