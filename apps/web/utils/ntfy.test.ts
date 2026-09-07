import { beforeEach, describe, expect, it, vi } from "vitest";

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
    } as Record<string, unknown>,
  };
});

vi.mock("@/env", () => ({ env: mockEnv }));

import { isNtfyEnabled, notifyOwner } from "@/utils/ntfy";

describe("ntfy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NTFY_BASE_URL = "https://ntfy.example.com";
    mockEnv.NTFY_TOPIC = "inbox";
    mockEnv.NTFY_TOKEN = "tk_test";
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

  it("does not throw on a non-2xx response", async () => {
    // A 403 from ntfy is a successful HTTP round-trip carrying a refusal.
    // fetch does not reject on it, so nothing else would notice.
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => "denied",
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      notifyOwner({ title: "Urgent", message: "x" }),
    ).resolves.toBeUndefined();
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
    // Title and Tags go into HTTP headers. An email subject containing CRLF
    // would otherwise inject headers into our own request.
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
});
