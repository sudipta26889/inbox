import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  on: vi.fn(),
  scan: vi.fn(),
  keys: vi.fn(),
  publish: vi.fn(),
  options: {} as Record<string, unknown>,
}));

vi.mock("ioredis", () => ({
  default: class {
    constructor(_url: string, options: Record<string, unknown>) {
      client.options = options;
      // biome-ignore lint/correctness/noConstructorReturn: mock returns the shared stub
      return client as never;
    }
  },
}));
vi.mock("@/env", () => ({ env: { REDIS_URL: "redis://test" } }));

import { redis } from "@/utils/redis";

describe("redis key prefix", () => {
  beforeEach(() => vi.clearAllMocks());

  it("prefixes key commands through the client option", () => {
    expect(client.options.keyPrefix).toBe("inbox:");
  });

  it("scans inside the prefix and returns keys callers can reuse", async () => {
    client.scan.mockResolvedValue(["0", ["inbox:thread:a:1"]]);

    const [, keys] = await redis.scan(0, { match: "thread:a:*", count: 10 });

    expect(client.scan).toHaveBeenCalledWith(
      0,
      "MATCH",
      "inbox:thread:a:*",
      "COUNT",
      10,
    );
    expect(keys).toEqual(["thread:a:1"]);
  });

  it("publishes on a prefixed channel", async () => {
    await redis.publish("thread:a:1", "{}");

    expect(client.publish).toHaveBeenCalledWith("inbox:thread:a:1", "{}");
  });
});
