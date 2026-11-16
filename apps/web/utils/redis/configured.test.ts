import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Upstream gated Redis features on its Upstash REST client (REDIS_HTTP_*).
// This deployment has only the ioredis wrapper on REDIS_URL, so the gates must
// follow REDIS_URL, or rate limits, 429 backoff, OAuth-callback dedupe and the
// caches silently switch off in production. NODE_ENV is production here so no
// gate's test-mode shortcut can make this pass.
vi.mock("@/env", () => ({
  env: { NODE_ENV: "production", REDIS_URL: "redis://valkey.test:6379/3" },
}));
vi.mock("@/utils/prisma");

import { isRedisConfigured } from "@/utils/redis/configured";
import { isOAuthCodeStoreConfigured } from "@/utils/redis/oauth-code";
import { isEmailProviderRateLimitRedisConfigured } from "@/utils/redis/email-provider-rate-limit";

const WEB_ROOT = join(import.meta.dirname, "..", "..");

// The page buffer is a separate Upstash client that stays off without
// REDIS_HTTP_URL; the config page only reports which settings are present.
const ALLOWED_REDIS_HTTP_USERS = [
  "app/(app)/config/page.tsx",
  "env.ts",
  "utils/redis/thread-page-buffer.ts",
];

describe("Redis feature gates", () => {
  it("are on when REDIS_URL is set and REDIS_HTTP_* is not", () => {
    expect(isRedisConfigured()).toBe(true);
    expect(isOAuthCodeStoreConfigured()).toBe(true);
    expect(isEmailProviderRateLimitRedisConfigured()).toBe(true);
  });

  it("no longer read REDIS_HTTP_* anywhere else", () => {
    const users = listSourceFiles(WEB_ROOT)
      .filter((file) =>
        /REDIS_HTTP_(URL|TOKEN)/.test(readFileSync(file, "utf8")),
      )
      .map((file) => relative(WEB_ROOT, file))
      .sort();

    expect(users).toEqual(ALLOWED_REDIS_HTTP_USERS);
  }, 30_000); // walks the whole source tree; slow when the machine is busy
});

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    if (
      ["node_modules", "__tests__", "generated", "scripts"].includes(name) ||
      name.startsWith(".")
    )
      return [];
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return listSourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)
      ? [path]
      : [];
  });
}
