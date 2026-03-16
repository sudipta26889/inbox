import IoRedis from "ioredis";
import { env } from "@/env";

const ioRedisClient = new IoRedis(env.REDIS_URL ?? "redis://localhost:6379", {
  maxRetriesPerRequest: 3,
  lazyConnect: true,
});

ioRedisClient.on("error", (err) => {
  console.error("[redis] connection error", err.message);
});

/**
 * Upstash-compatible Redis wrapper over ioredis.
 *
 * Provides the same API surface the codebase relied on from @upstash/redis:
 * - auto JSON serialization on set / hset
 * - auto JSON deserialization on get / hget / hgetall
 * - Upstash-style eval(script, keys[], args[])
 * - Upstash-style scan(cursor, { match, count }) returning [cursor, keys]
 */
export const redis = {
  async get<T = string>(key: string): Promise<T | null> {
    const raw = await ioRedisClient.get(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  },

  async set(
    key: string,
    value: unknown,
    opts?: { ex?: number; nx?: boolean },
  ): Promise<string | null> {
    const serialized = typeof value === "string" ? value : JSON.stringify(value);
    const args: string[] = [];
    if (opts?.ex) {
      args.push("EX", opts.ex.toString());
    }
    if (opts?.nx) {
      args.push("NX");
    }
    return ioRedisClient.set(key, serialized, ...args);
  },

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return ioRedisClient.del(...keys);
  },

  async unlink(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return ioRedisClient.unlink(...keys);
  },

  async expire(key: string, seconds: number): Promise<number> {
    return ioRedisClient.expire(key, seconds);
  },

  async incr(key: string): Promise<number> {
    return ioRedisClient.incr(key);
  },

  async keys(pattern: string): Promise<string[]> {
    return ioRedisClient.keys(pattern);
  },

  async publish(channel: string, message: string): Promise<number> {
    return ioRedisClient.publish(channel, message);
  },

  // --- Hash operations ---

  async hget<T = string>(key: string, field: string): Promise<T | null> {
    const raw = await ioRedisClient.hget(key, field);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return raw as T;
    }
  },

  async hset(key: string, fieldValues: Record<string, unknown>): Promise<number> {
    const serialized: Record<string, string> = {};
    for (const [field, value] of Object.entries(fieldValues)) {
      serialized[field] = typeof value === "string" ? value : JSON.stringify(value);
    }
    return ioRedisClient.hset(key, serialized);
  },

  async hdel(key: string, ...fields: string[]): Promise<number> {
    return ioRedisClient.hdel(key, ...fields);
  },

  async hgetall<T = Record<string, string>>(key: string): Promise<T | null> {
    const raw = await ioRedisClient.hgetall(key);
    if (!raw || Object.keys(raw).length === 0) return null;
    const result: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(raw)) {
      try {
        result[field] = JSON.parse(value);
      } catch {
        const num = Number(value);
        result[field] = Number.isNaN(num) ? value : num;
      }
    }
    return result as T;
  },

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    return ioRedisClient.hincrby(key, field, increment);
  },

  async hincrbyfloat(key: string, field: string, increment: number): Promise<string> {
    return ioRedisClient.hincrbyfloat(key, field, increment);
  },

  // --- List operations ---

  async rpush(key: string, ...values: string[]): Promise<number> {
    return ioRedisClient.rpush(key, ...values);
  },

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    return ioRedisClient.lrange(key, start, stop);
  },

  async llen(key: string): Promise<number> {
    return ioRedisClient.llen(key);
  },

  // --- Sorted set operations ---

  async zrem(key: string, ...members: string[]): Promise<number> {
    return ioRedisClient.zrem(key, ...members);
  },

  // --- Scan ---

  async scan(
    cursor: number | string,
    opts?: { match?: string; count?: number },
  ): Promise<[string, string[]]> {
    const args: (string | number)[] = [];
    if (opts?.match) {
      args.push("MATCH", opts.match);
    }
    if (opts?.count) {
      args.push("COUNT", opts.count);
    }
    const [nextCursor, keys] = await ioRedisClient.scan(
      typeof cursor === "string" ? Number.parseInt(cursor, 10) : cursor,
      ...args,
    );
    return [String(nextCursor), keys];
  },

  // --- Eval (Upstash signature: eval<Keys, Return>(script, keys[], args[])) ---

  async eval<_Keys extends string[] = string[], TReturn = unknown>(
    script: string,
    keys: string[],
    args: (string | number)[],
  ): Promise<TReturn> {
    const result = await ioRedisClient.eval(
      script,
      keys.length,
      ...keys,
      ...args.map(String),
    );
    return result as TReturn;
  },
};

export async function expire(key: string, seconds: number) {
  return redis.expire(key, seconds);
}
