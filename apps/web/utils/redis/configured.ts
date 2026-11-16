import { env } from "@/env";

/**
 * Redis-backed features (rate limits, provider backoff, OAuth-code dedupe,
 * caches) run when the ioredis wrapper's REDIS_URL is set. Upstream gated
 * them on its Upstash REST client, which this deployment does not run.
 */
export function isRedisConfigured() {
  return Boolean(env.REDIS_URL);
}
