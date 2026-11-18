import { appendFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { expect } from "vitest";

/**
 * Unit tests must never reach a real host. Installed from the vitest setup file:
 * a request to any host other than localhost, 127.0.0.1, ::1 or *.test throws.
 * Tests that stub fetch, or mock the module that makes the call, replace these
 * wrappers and are unaffected. Not installed for the AI eval and e2e suites,
 * which need the network (RUN_AI_TESTS, RUN_E2E_TESTS, RUN_E2E_FLOW_TESTS).
 */
export function installNoNetworkGuard() {
  if (isNetworkSuite()) return;

  guardFetch();
  guardHttp(http);
  guardHttp(https);
}

function isNetworkSuite() {
  return (
    process.env.RUN_AI_TESTS === "true" ||
    process.env.RUN_E2E_TESTS === "true" ||
    process.env.RUN_E2E_FLOW_TESTS === "true"
  );
}

export function isAllowedTestHost(host: string): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");

  return (
    name === "localhost" ||
    name === "127.0.0.1" ||
    name === "::1" ||
    name.endsWith(".localhost") ||
    name.endsWith(".test")
  );
}

function assertAllowed(host: string | undefined, origin: string) {
  if (!host || isAllowedTestHost(host)) return;

  const message = `Unit test tried to reach a real host: ${origin} — stub fetch or inject a client`;
  recordBlocked(message);

  throw new Error(message);
}

// Code under test often catches and swallows the error, so a blocked call can
// pass silently. NO_NETWORK_GUARD_LOG=<file> records each one with its test.
function recordBlocked(message: string) {
  const file = process.env.NO_NETWORK_GUARD_LOG;
  if (!file) return;

  const { testPath, currentTestName } = expect.getState();
  appendFileSync(file, `${testPath}\t${currentTestName}\t${message}\n`);
}

function guardFetch() {
  const realFetch = globalThis.fetch;
  if (!realFetch) return;

  const guarded = ((input: unknown, init?: unknown) => {
    const url = urlOf(input);
    // data: and blob: URLs have no host and never leave the process.
    if (url && url.protocol !== "data:" && url.protocol !== "blob:") {
      try {
        assertAllowed(url.hostname, url.origin);
      } catch (error) {
        // fetch rejects rather than throws, so `.catch` chains keep working.
        return Promise.reject(error);
      }
      // A *.test host is allowed so that a stub can be addressed to it, but a
      // call that reaches this wrapper was not stubbed: it will fail at DNS.
      if (url.hostname.endsWith(".test")) {
        recordBlocked(`Unstubbed call to ${url.origin}${url.pathname}`);
      }
    }

    return realFetch(input as never, init as never);
  }) as typeof fetch;

  globalThis.fetch = guarded;
}

function urlOf(input: unknown): URL | undefined {
  try {
    if (typeof input === "string") return new URL(input);
    if (input instanceof URL) return input;
    if (input && typeof input === "object" && "url" in input) {
      return new URL(String((input as { url: unknown }).url));
    }
  } catch {
    return;
  }

  return;
}

type HttpModule = typeof http | typeof https;

function guardHttp(mod: HttpModule) {
  for (const method of ["request", "get"] as const) {
    const real = mod[method] as (...args: unknown[]) => unknown;

    (mod as unknown as Record<string, unknown>)[method] = (
      ...args: unknown[]
    ) => {
      const target = httpTarget(args);
      assertAllowed(target.host, target.origin);

      return real.apply(mod, args);
    };
  }
}

function httpTarget(args: unknown[]): { host?: string; origin: string } {
  const [first, second] = args;

  if (typeof first === "string" || first instanceof URL) {
    const url = urlOf(first);
    return { host: url?.hostname, origin: url?.origin ?? String(first) };
  }

  const options = (first ?? second ?? {}) as {
    hostname?: string;
    host?: string;
    protocol?: string;
    port?: number | string;
  };
  const host = options.hostname ?? options.host ?? "localhost";
  const origin = `${options.protocol ?? "http:"}//${host}${options.port ? `:${options.port}` : ""}`;

  return { host: host.replace(/:\d+$/, ""), origin };
}
