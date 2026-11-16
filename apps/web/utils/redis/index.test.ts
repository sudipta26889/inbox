import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const client = vi.hoisted(() => ({
  on: vi.fn(),
  scan: vi.fn(),
  keys: vi.fn(),
  publish: vi.fn(),
  getdel: vi.fn(),
  exists: vi.fn(),
  set: vi.fn(),
  hincrbyfloat: vi.fn(),
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
vi.mock("@/env", () => ({
  env: { REDIS_URL: "redis://test", REDIS_KEY_PREFIX: "inbox:" },
}));

import { redis } from "@/utils/redis";

const WEB_ROOT = join(import.meta.dirname, "..", "..");

// Raw ioredis clients get no prefix from the shared wrapper. Each one listed
// here was checked to prefix its keys, channels or keyPrefix by hand with
// REDIS_KEY_PREFIX. A new raw client (for example from an upstream merge)
// fails this test until it is checked and added.
const REVIEWED_RAW_CLIENTS = [
  "app/api/email-stream/route.ts",
  "app/api/mail-stream/route.ts",
  "app/api/team-comments/stream/route.ts",
  "utils/chat/active-run.ts",
  "utils/messaging/chat-sdk/bot.ts",
  // Only constructed with QUEUE_BACKEND=bullmq, which is not deployed.
  "utils/queue/bullmq.ts",
  "utils/redis/index.ts",
  "utils/redis/subscriber.ts",
  // Upstash REST client, built only when REDIS_HTTP_URL is https; the stacks
  // set no REDIS_HTTP_URL, so the page buffer stays off.
  "utils/redis/thread-page-buffer.ts",
  "utils/team-comments/events.ts",
];

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

  it("lists keys inside the prefix", async () => {
    client.keys.mockResolvedValue(["inbox:a:1"]);

    await expect(redis.keys("a:*")).resolves.toEqual(["a:1"]);
    expect(client.keys).toHaveBeenCalledWith("inbox:a:*");
  });

  it("publishes on a prefixed channel", async () => {
    await redis.publish("thread:a:1", "{}");

    expect(client.publish).toHaveBeenCalledWith("inbox:thread:a:1", "{}");
  });

  it("supports the Upstash calls upstream code makes", async () => {
    client.getdel.mockResolvedValue('{"a":1}');
    client.exists.mockResolvedValue(1);

    await expect(redis.getdel("k")).resolves.toEqual({ a: 1 });
    await expect(redis.exists("k")).resolves.toBe(1);
  });

  it("returns the old value from SET ... GET like the Upstash client", async () => {
    client.set.mockResolvedValue('{"status":"processing"}');

    const existing = await redis.set<{ status: string }>(
      "oauth:code",
      { status: "processing" },
      { ex: 600, nx: true, get: true },
    );

    expect(client.set).toHaveBeenCalledWith(
      "oauth:code",
      '{"status":"processing"}',
      "EX",
      "600",
      "NX",
      "GET",
    );
    expect(existing).toEqual({ status: "processing" });
  });

  it("returns a number from hincrbyfloat like the Upstash client", async () => {
    client.hincrbyfloat.mockResolvedValue("1.5");

    await expect(redis.hincrbyfloat("usage", "cost", 0.5)).resolves.toBe(1.5);
  });

  it("has no unreviewed raw ioredis client", () => {
    const rawClients = listSourceFiles(WEB_ROOT)
      .filter((file) =>
        /new (IoRedis|IORedis|Redis)\(|RedisSubscriber\.createInstance\(|createIoRedisState\(/.test(
          readFileSync(file, "utf8"),
        ),
      )
      .map((file) => relative(WEB_ROOT, file))
      .filter((file) => !file.startsWith("scripts/"));

    expect(rawClients.sort()).toEqual(REVIEWED_RAW_CLIENTS);
  });
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (
      name === "node_modules" ||
      name === "__tests__" ||
      name === "generated" ||
      name.startsWith(".")
    ) {
      return [];
    }
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}
