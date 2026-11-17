import { env } from "@/env";

export const LOCAL_BYPASS_USER_EMAIL = "local-bypass@inboxzero.local";
export const LOCAL_BYPASS_USER_NAME = "Local Test User";
export const LOCAL_BYPASS_PROVIDER = "google";
export const LOCAL_BYPASS_PROVIDER_ACCOUNT_PREFIX = "local-bypass:";
export const LOCAL_BYPASS_ACCESS_TOKEN = "local-bypass-access-token";

/**
 * The one gate for the dev login bypass. Open in either of two ways:
 *  (a) NODE_ENV=development with LOCAL_AUTH_BYPASS_ENABLED, or
 *  (b) a LAN preview build: LOCAL_AUTH_BYPASS_ENABLED and LOCAL_PREVIEW, a
 *      database named inbox_refork_*, and a base URL on localhost or *.lan.
 * Production cannot satisfy (b): its database is not inbox_refork_*, and its
 * base URL is a public https host.
 */
export function isLocalAuthBypassEnabled() {
  if (!env.LOCAL_AUTH_BYPASS_ENABLED) return false;
  if (env.NODE_ENV === "development") return true;

  return isLocalPreview();
}

function isLocalPreview() {
  return (
    env.LOCAL_PREVIEW === true &&
    PREVIEW_DATABASE_NAME.test(databaseName(env.DATABASE_URL)) &&
    isLanHost(hostName(env.NEXT_PUBLIC_BASE_URL))
  );
}

const PREVIEW_DATABASE_NAME = /^inbox_refork_/;

function databaseName(url: string | undefined): string {
  try {
    return decodeURIComponent(new URL(url ?? "").pathname.replace(/^\//, ""));
  } catch {
    return "";
  }
}

function hostName(url: string | undefined): string {
  try {
    return new URL(url ?? "").hostname.toLowerCase();
  } catch {
    return "";
  }
}

function isLanHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host.endsWith(".lan");
}

/**
 * The existing user the bypass should sign in as, if one is configured. It sits
 * behind the same gate as the bypass itself, so outside development it is
 * always undefined.
 */
export function getLocalBypassTargetEmail(): string | undefined {
  if (!isLocalAuthBypassEnabled()) return;

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
