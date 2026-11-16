import { env } from "@/env";

/**
 * Every app on the shared Valkey keeps its keys and channels under its own
 * prefix, and its ACL user is limited to it (production `inbox:`, staging
 * `inbox-staging:`). ioredis `keyPrefix` covers key arguments only: SCAN/KEYS
 * patterns and pub/sub channels must add this by hand.
 */
// ponytail: the ?? only serves tests that mock @/env without this key.
export const REDIS_KEY_PREFIX = env.REDIS_KEY_PREFIX ?? "inbox:";
