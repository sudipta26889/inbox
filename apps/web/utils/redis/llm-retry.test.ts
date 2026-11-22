import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import {
  forgetLlmRetry,
  getLlmRetryEntries,
  getLlmRetryMaxAgeMs,
  rememberLlmRetry,
} from "./llm-retry";

const redis = vi.hoisted(() => ({
  zaddNx: vi.fn(),
  expire: vi.fn(),
  zrangeWithScores: vi.fn(),
  zrem: vi.fn(),
}));
const envMock = vi.hoisted(() => ({
  LLM_RETRY_MAX_AGE_HOURS: undefined as number | undefined,
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({ redis }));
vi.mock("@/env", () => ({ env: envMock }));

const logger = createTestLogger();

describe("llm retry set", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.LLM_RETRY_MAX_AGE_HOURS = undefined;
  });

  it("defaults the retry window to 72 hours", () => {
    expect(getLlmRetryMaxAgeMs()).toBe(72 * 60 * 60 * 1000);
  });

  it("takes the retry window from LLM_RETRY_MAX_AGE_HOURS", () => {
    envMock.LLM_RETRY_MAX_AGE_HOURS = 120;
    expect(getLlmRetryMaxAgeMs()).toBe(120 * 60 * 60 * 1000);
  });

  it("keeps the queue 24 hours longer than the retry window", async () => {
    envMock.LLM_RETRY_MAX_AGE_HOURS = 120;

    await rememberLlmRetry({ emailAccountId: "a1", messageId: "m1", logger });

    expect(redis.expire).toHaveBeenCalledWith("llm-retry:a1", 144 * 60 * 60);
  });

  it("keeps the first failure time and sets a TTL", async () => {
    await rememberLlmRetry({ emailAccountId: "a1", messageId: "m1", logger });

    expect(redis.zaddNx).toHaveBeenCalledWith(
      "llm-retry:a1",
      expect.any(Number),
      "m1",
    );
    expect(redis.expire).toHaveBeenCalledWith("llm-retry:a1", 345_600);
  });

  it("returns entries oldest first", async () => {
    redis.zrangeWithScores.mockResolvedValue([
      { member: "m1", score: 10 },
      { member: "m2", score: 20 },
    ]);

    await expect(
      getLlmRetryEntries({ emailAccountId: "a1", logger }),
    ).resolves.toEqual([
      { messageId: "m1", firstFailedAt: 10 },
      { messageId: "m2", firstFailedAt: 20 },
    ]);
  });

  it("never throws when Redis fails", async () => {
    redis.zaddNx.mockRejectedValue(new Error("redis down"));
    redis.zrangeWithScores.mockRejectedValue(new Error("redis down"));
    redis.zrem.mockRejectedValue(new Error("redis down"));

    await rememberLlmRetry({ emailAccountId: "a1", messageId: "m1", logger });
    await expect(
      getLlmRetryEntries({ emailAccountId: "a1", logger }),
    ).resolves.toEqual([]);
    await forgetLlmRetry({
      emailAccountId: "a1",
      messageIds: ["m1"],
      logger,
    });
  });

  it("does nothing when there is nothing to forget", async () => {
    await forgetLlmRetry({ emailAccountId: "a1", messageIds: [], logger });
    expect(redis.zrem).not.toHaveBeenCalled();
  });
});
