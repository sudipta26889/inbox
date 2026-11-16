import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";

const { afterCallbacks, markOwnedLockProcessed } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => Promise<void>>,
  markOwnedLockProcessed: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
  after: (callback: () => Promise<void>) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/redis", () => ({ redis: { get: vi.fn() } }));
vi.mock("@/utils/redis/owned-lock", () => ({
  acquireOwnedLock: vi.fn(async () => "token"),
  clearOwnedLock: vi.fn(),
  markOwnedLockProcessed,
}));

import { scheduleAccountAnalysis } from "./schedule-account-analysis";

describe("scheduleAccountAnalysis", () => {
  beforeEach(() => {
    afterCallbacks.length = 0;
    vi.clearAllMocks();
  });

  async function runWith(run: () => Promise<boolean>) {
    await scheduleAccountAnalysis({
      emailAccountId: "acc",
      kind: "writing-style",
      logger: createTestLogger(),
      run,
    });
    await afterCallbacks[0]();
    return markOwnedLockProcessed.mock.calls[0][0];
  }

  it("holds a failed analysis off for a day instead of retrying on every page load", async () => {
    const marked = await runWith(async () => {
      throw new Error("model returned invalid JSON");
    });

    expect(marked).toMatchObject({
      processedStatus: "cooldown",
      processedTtlSeconds: 24 * 60 * 60,
    });
  });

  it("keeps the short lock after a run that finished", async () => {
    const marked = await runWith(async () => true);

    expect(marked).toMatchObject({
      processedStatus: "completed",
      processedTtlSeconds: 60,
    });
  });
});
