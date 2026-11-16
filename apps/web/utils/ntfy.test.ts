import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

// `@/env` (t3-env) parses `process.env` once, eagerly, at import time and
// returns a Proxy over a plain object rather than a live view of
// process.env — vi.stubEnv mutates process.env after that parse has already
// happened, so it never reaches code that already imported `env`. The
// repo's established pattern (see utils/mqtt/client.test.ts) is to replace
// the whole module with a mutable plain object instead.
const { mockEnv } = vi.hoisted(() => {
  return {
    mockEnv: {
      NTFY_BASE_URL: "https://ntfy.example.com",
      NTFY_TOPIC: "inbox",
      NTFY_TOKEN: "tk_test",
      ADMINS: ["admin@example.com"] as string[] | undefined,
    } as Record<string, unknown>,
  };
});

vi.mock("@/env", () => ({ env: mockEnv }));

import { isNtfyEnabled, isOwnerEmailAccount, notifyOwner } from "@/utils/ntfy";

describe("ntfy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NTFY_BASE_URL = "https://ntfy.example.com";
    mockEnv.NTFY_TOPIC = "inbox";
    mockEnv.NTFY_TOKEN = "tk_test";
    mockEnv.ADMINS = ["admin@example.com"];
  });

  it("posts the message to the configured topic with bearer auth", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({ title: "Urgent", message: "from a@b.com" });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://ntfy.example.com/inbox");
    expect(init.headers.Authorization).toBe("Bearer tk_test");
    expect(init.headers.Title).toBe("Urgent");
    expect(init.body).toBe("from a@b.com");
  });

  it("does not throw when the server is unreachable", async () => {
    // The fail-soft path, tested deliberately. An urgent email must still be
    // processed when the notification server is down.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
    );

    await expect(
      notifyOwner({ title: "Urgent", message: "x" }),
    ).resolves.toBeUndefined();
  });

  it("warns and does not throw on a non-2xx response", async () => {
    // A 403 from ntfy is a successful HTTP round-trip carrying a refusal.
    // fetch does not reject on it, so this warn is the only signal that
    // anything went wrong.
    const warnSpy = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "denied",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      notifyOwner({ title: "Urgent", message: "x" }),
    ).resolves.toBeUndefined();

    expect(
      warnSpy.mock.calls.map((call) => call.join(" ")).join("\n"),
    ).toContain("ntfy refused the notification");
  });

  it("strips a trailing slash from NTFY_BASE_URL", async () => {
    mockEnv.NTFY_BASE_URL = "https://ntfy.example.com/";
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({ title: "Urgent", message: "x" });

    expect(fetchMock.mock.calls[0][0]).toBe("https://ntfy.example.com/inbox");
  });

  it("sends nothing at all when not configured", async () => {
    mockEnv.NTFY_BASE_URL = "";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({ title: "Urgent", message: "x" });

    // The negative control for the disabled path. If this fires, an instance
    // with no ntfy configured is POSTing somewhere.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(isNtfyEnabled()).toBe(false);
  });

  it("strips newlines from header values", async () => {
    // Title and Tags go into HTTP headers. rule.ruleName is free text an
    // account holder controls (Rule.name), so it could carry CRLF and inject
    // headers into our own request — an email subject never reaches a
    // header, only the request body.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({
      title: "Subject\r\nX-Injected: yes",
      message: "body",
    });

    expect(fetchMock.mock.calls[0][1].headers.Title).not.toContain("\n");
    expect(fetchMock.mock.calls[0][1].headers.Title).not.toContain("\r");
  });

  it("truncates an over-long title to 200 characters without reintroducing a newline", async () => {
    // Constructed so the CRLF sits exactly at the 200-character boundary:
    // stripping before slicing keeps the length at 200, but slicing before
    // stripping would cut through the "\r\n" and then collapse it away,
    // silently shortening the result to 199 — this is what catches a
    // reordering of the two operations.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    const title = `${"a".repeat(198)}\r\n${"b".repeat(10)}`;

    await notifyOwner({ title, message: "body" });

    expect(fetchMock.mock.calls[0][1].headers.Title).toHaveLength(200);
  });

  it.each([
    ["an emoji", "🚨 Urgent"],
    ["Devanagari script", "अत्यावश्यक"],
    ["a control character", "a\x00b"],
  ])("encodes a title containing %s so a real Headers object accepts it", async (_label, title) => {
    // Node's fetch rejects header values outside Latin-1 (a ByteString
    // conversion error) and raw control characters — a throw that lands
    // inside notifyOwner's try/catch, silently dropping the notification
    // while logging the unrelated lie "Could not reach ntfy". A plain
    // object stub for fetch (as the other tests in this file use) never
    // exercises that validation, which is exactly why the bug was
    // invisible; constructing a real Headers object here does.
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({ title, message: "body" });

    const sentTitle = fetchMock.mock.calls[0][1].headers.Title;
    expect(() => new Headers({ Title: sentTitle })).not.toThrow();
  });

  it("passes a plain Latin-1 title through unchanged", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: async () => "{}" });
    vi.stubGlobal("fetch", fetchMock);

    await notifyOwner({ title: "Grüße", message: "body" });

    expect(fetchMock.mock.calls[0][1].headers.Title).toBe("Grüße");
  });
});

describe("isOwnerEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NTFY_BASE_URL = "https://ntfy.example.com";
    mockEnv.NTFY_TOPIC = "inbox";
    mockEnv.NTFY_TOKEN = "tk_test";
    mockEnv.ADMINS = ["admin@example.com"];
  });

  it("returns true for an admin account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: { email: "admin@example.com" },
    } as any);

    await expect(isOwnerEmailAccount("account-1")).resolves.toBe(true);
  });

  it("returns false for a non-admin account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      user: { email: "someone-else@example.com" },
    } as any);

    await expect(isOwnerEmailAccount("account-1")).resolves.toBe(false);
  });

  it("returns false when the account does not exist", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    await expect(isOwnerEmailAccount("missing-account")).resolves.toBe(false);
  });

  it("returns false without reading the database when ntfy is not configured", async () => {
    mockEnv.NTFY_BASE_URL = "";

    await expect(isOwnerEmailAccount("account-1")).resolves.toBe(false);
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });
});
