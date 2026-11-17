import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NODE_ENV: "production" as string,
    LOCAL_AUTH_BYPASS_ENABLED: true,
    LOCAL_PREVIEW: true,
    DATABASE_URL: "postgresql://u:p@db.lan:5432/inbox_refork_staging",
    NEXT_PUBLIC_BASE_URL: "http://dharabot.lan:5501",
  },
}));
vi.mock("@/env", () => ({ env: mockEnv }));

import { isLocalAuthBypassEnabled } from "./local-bypass-config";

describe("isLocalAuthBypassEnabled", () => {
  beforeEach(() => {
    mockEnv.NODE_ENV = "production";
    mockEnv.LOCAL_AUTH_BYPASS_ENABLED = true;
    mockEnv.LOCAL_PREVIEW = true;
    mockEnv.DATABASE_URL = "postgresql://u:p@db.lan:5432/inbox_refork_staging";
    mockEnv.NEXT_PUBLIC_BASE_URL = "http://dharabot.lan:5501";
  });

  describe("(a) development", () => {
    it("is enabled with NODE_ENV=development and the flag", () => {
      mockEnv.NODE_ENV = "development";
      mockEnv.LOCAL_PREVIEW = false;
      mockEnv.DATABASE_URL = "postgresql://u:p@db.lan:5432/inbox_dev";
      mockEnv.NEXT_PUBLIC_BASE_URL = "https://inbox.sudiptadhara.in";

      expect(isLocalAuthBypassEnabled()).toBe(true);
    });

    it("is off in development without the flag", () => {
      mockEnv.NODE_ENV = "development";
      mockEnv.LOCAL_AUTH_BYPASS_ENABLED = false;

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });
  });

  describe("(b) a LAN preview build", () => {
    it("is enabled when all four conditions hold", () => {
      expect(isLocalAuthBypassEnabled()).toBe(true);
    });

    it.each([
      "http://localhost:5501",
      "http://127.0.0.1:5501",
      "http://dharabot.lan:5501",
      "http://nas.lan",
    ])("accepts the base URL %s", (url) => {
      mockEnv.NEXT_PUBLIC_BASE_URL = url;

      expect(isLocalAuthBypassEnabled()).toBe(true);
    });

    it("accepts a database name with a query string", () => {
      mockEnv.DATABASE_URL =
        "postgresql://u:p@db.lan:5432/inbox_refork_2?sslmode=disable";

      expect(isLocalAuthBypassEnabled()).toBe(true);
    });

    it("is off when LOCAL_AUTH_BYPASS_ENABLED is off", () => {
      mockEnv.LOCAL_AUTH_BYPASS_ENABLED = false;

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });

    it("is off when LOCAL_PREVIEW is off", () => {
      mockEnv.LOCAL_PREVIEW = false;

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });

    it.each([
      ["production's database", "postgresql://u:p@db.lan:5432/inbox_zero_db"],
      ["the dev database", "postgresql://u:p@db.lan:5432/inbox_dev"],
      [
        "a name that only contains the prefix",
        "postgresql://u:p@db.lan:5432/x_inbox_refork_1",
      ],
      ["no database name", "postgresql://u:p@db.lan:5432"],
    ])("is off for %s", (_name, url) => {
      mockEnv.DATABASE_URL = url;

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });

    it.each([
      ["the public https host", "https://inbox.sudiptadhara.in"],
      ["a public host that ends like a lan one", "https://evil.example/.lan"],
      ["a host that merely contains lan", "http://lan.evil.example"],
      ["a host ending in lan without a dot", "http://notlan"],
      ["an unparseable URL", "not a url"],
      ["no URL", ""],
    ])("is off for %s", (_name, url) => {
      mockEnv.NEXT_PUBLIC_BASE_URL = url;

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });

    it("production's real settings never open it, even with both flags set", () => {
      mockEnv.DATABASE_URL = "postgresql://u:p@db.lan:5432/inbox_zero_db";
      mockEnv.NEXT_PUBLIC_BASE_URL = "https://inbox.sudiptadhara.in";

      expect(isLocalAuthBypassEnabled()).toBe(false);
    });
  });
});
