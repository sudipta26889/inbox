import { env } from "@/env";

export const LOCAL_BYPASS_USER_EMAIL = "local-bypass@inboxzero.local";
export const LOCAL_BYPASS_USER_NAME = "Local Test User";
export const LOCAL_BYPASS_PROVIDER = "google";
export const LOCAL_BYPASS_PROVIDER_ACCOUNT_PREFIX = "local-bypass:";
export const LOCAL_BYPASS_ACCESS_TOKEN = "local-bypass-access-token";

export function isLocalAuthBypassEnabled() {
  return env.NODE_ENV === "development" && env.LOCAL_AUTH_BYPASS_ENABLED;
}

/**
 * The existing user the bypass should sign in as, if one is configured. It sits
 * behind the same gate as the bypass itself, so outside development it is
 * always undefined.
 */
export function getLocalBypassTargetEmail(): string | undefined {
  if (!isLocalAuthBypassEnabled()) return undefined;

  return env.LOCAL_AUTH_BYPASS_USER_EMAIL?.trim() || undefined;
}

export function getLocalBypassProviderAccountId(userId: string) {
  return `${LOCAL_BYPASS_PROVIDER_ACCOUNT_PREFIX}${userId}`;
}

export function isLocalBypassProviderAccountId(
  providerAccountId: string | null | undefined,
) {
  return (
    !!providerAccountId &&
    providerAccountId.startsWith(LOCAL_BYPASS_PROVIDER_ACCOUNT_PREFIX)
  );
}

export function isLocalBypassUserEmail(email: string | null | undefined) {
  return email?.toLowerCase() === LOCAL_BYPASS_USER_EMAIL;
}
