import { beforeEach, describe, expect, it, vi } from "vitest";

const { sweepMock, backfillMock } = vi.hoisted(() => ({
  sweepMock: vi.fn(),
  backfillMock: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: { CRON_SECRET: "cron-secret" },
}));
vi.mock("@/utils/taskpilot/janitor", () => ({
  sweepStaleRunningDecisions: () => sweepMock(),
}));
vi.mock("@/utils/taskpilot/link-backfill", () => ({
  backfillTaskpilotLinks: (...args: unknown[]) => backfillMock(...args),
  LINK_BACKFILL_DELAY_MS: 0,
  LINK_BACKFILL_MAX_PER_RUN: 1,
  LINK_BACKFILL_MAX_TOTAL: 1,
}));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

import { GET } from "./route";

const URL = "http://localhost:3000/api/cron/taskpilot-janitor";

describe("taskpilot janitor cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sweepMock.mockResolvedValue({ reaped: 2 });
    backfillMock.mockResolvedValue(undefined);
  });

  it("rejects requests without the cron secret", async () => {
    const response = await GET(new Request(URL));

    expect(response.status).toBe(401);
    expect(sweepMock).not.toHaveBeenCalled();
  });

  it("sweeps and backfills with the cron secret", async () => {
    const response = await GET(
      new Request(URL, { headers: { authorization: "Bearer cron-secret" } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ reaped: 2 });
    expect(backfillMock).toHaveBeenCalledOnce();
  });

  it("still succeeds when the link backfill throws", async () => {
    backfillMock.mockRejectedValue(new Error("taskpilot down"));

    const response = await GET(
      new Request(URL, { headers: { authorization: "Bearer cron-secret" } }),
    );

    expect(response.status).toBe(200);
  });
});
