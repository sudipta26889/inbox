import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildMcpToolContext } from "@/utils/mcp-server/tool-context";
import { validateAccessToken } from "@/utils/mcp-server/tokens";
import {
  BASE,
  MCP_SCOPES_SUPPORTED,
  PRM_URL,
} from "@/utils/mcp-server/constants";
import { GET, POST } from "./route";

const { toolHandler } = vi.hoisted(() => ({ toolHandler: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: { emailAccount: { findMany: vi.fn(() => []) } },
}));
vi.mock("@/utils/mcp-server/tokens", () => ({
  validateAccessToken: vi.fn(),
}));
vi.mock("@/utils/mcp-server/tool-context", () => ({
  buildMcpToolContext: vi.fn(),
}));
vi.mock("@/utils/mcp-server/tools/registry", () => ({
  getAllTools: vi.fn(() => []),
  getTool: vi.fn(() => ({ handler: toolHandler })),
  hasRequiredScope: vi.fn(() => true),
}));

const context = { params: Promise.resolve({}) };
const METHOD_MARKER = "marker/method-value";

describe("POST /mcp-server", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateAccessToken).mockResolvedValue({
      sub: "user-1",
      email_account_id: "account-1",
      client_id: "client-1",
      scope: "mcp:write email:write",
    } as never);
    vi.mocked(buildMcpToolContext).mockResolvedValue({} as never);
    toolHandler.mockResolvedValue({ ok: true });
  });

  it("returns 401 with no credentials, without reading or logging the body", async () => {
    const log = vi.spyOn(console, "log");
    const request = post({ jsonrpc: "2.0", id: 1, method: METHOD_MARKER });

    const response = await POST(request, context);

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
    expect(challenge).toContain(`scope="${MCP_SCOPES_SUPPORTED.join(" ")}"`);
    expect(challenge).not.toContain("invalid_token");
    expect(request.bodyUsed).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(METHOD_MARKER);
  });

  it("does not fall back to a browser session", async () => {
    const response = await POST(
      new NextRequest("http://localhost/mcp-server", {
        method: "POST",
        body: "{}",
        headers: { Cookie: "authjs.session-token=abc" },
      }),
      context,
    );

    expect(response.status).toBe(401);
    expect(validateAccessToken).not.toHaveBeenCalled();
  });

  it("returns 401 for an invalid token, without reading the body", async () => {
    vi.mocked(validateAccessToken).mockResolvedValue(null as never);
    const request = post(
      { jsonrpc: "2.0", id: 1, method: METHOD_MARKER },
      "bad-token",
    );

    const response = await POST(request, context);

    expect(response.status).toBe(401);
    const challenge = response.headers.get("www-authenticate");
    expect(challenge).toContain('error="invalid_token"');
    expect(challenge).toContain(`resource_metadata="${PRM_URL}"`);
    expect(challenge).toContain("scope=");
    expect(request.bodyUsed).toBe(false);
  });

  describe("Origin", () => {
    it.each([
      ["absent", undefined],
      ["the server's own origin", BASE],
      ["localhost with a port", "http://localhost:6274"],
      ["IPv6 loopback with a port", "http://[::1]:1234"],
    ])("allows %s", async (_name, origin) => {
      const response = await POST(
        post({ jsonrpc: "2.0", id: 1, method: "ping" }, "good-token", {
          origin,
        }),
        context,
      );

      expect(response.status).toBe(200);
    });

    it.each([
      ["a foreign site", "https://evil.example"],
      ["the literal null", "null"],
      ["an unparseable value", "not a url"],
    ])("rejects %s with 403 before authenticating", async (_name, origin) => {
      const response = await POST(
        post({ jsonrpc: "2.0", id: 1, method: "ping" }, "good-token", {
          origin,
        }),
        context,
      );

      expect(response.status).toBe(403);
      expect(validateAccessToken).not.toHaveBeenCalled();
    });
  });

  describe("MCP-Protocol-Version", () => {
    it.each([
      ["absent", undefined],
      ["supported", "2025-06-18"],
    ])("allows %s", async (_name, version) => {
      const response = await POST(
        post({ jsonrpc: "2.0", id: 1, method: "ping" }, "good-token", {
          "mcp-protocol-version": version,
        }),
        context,
      );

      expect(response.status).toBe(200);
    });

    it("rejects an unsupported version with 400", async () => {
      const response = await POST(
        post({ jsonrpc: "2.0", id: 1, method: "ping" }, "good-token", {
          "mcp-protocol-version": "1999-01-01",
        }),
        context,
      );

      expect(response.status).toBe(400);
    });

    it("lets browsers send the version and session headers", async () => {
      const { OPTIONS } = await import("./route");
      const allowed = (await OPTIONS()).headers.get(
        "access-control-allow-headers",
      );

      expect(allowed).toContain("MCP-Protocol-Version");
      expect(allowed).toContain("Mcp-Session-Id");
    });
  });

  it("answers GET with 405 and the allowed methods", async () => {
    const response = await GET();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("answers an authenticated initialize", async () => {
    const response = await POST(
      post({ jsonrpc: "2.0", id: 1, method: "initialize" }, "good-token"),
      context,
    );

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.id).toBe(1);
    expect(payload.result.protocolVersion).toBe("2024-11-05");
  });

  it("accepts an authenticated notifications/initialized", async () => {
    const response = await POST(
      post(
        { jsonrpc: "2.0", method: "notifications/initialized" },
        "good-token",
      ),
      context,
    );

    expect(response.status).toBe(202);
  });

  it("accepts an authenticated create_draft with a 20 MB attachment", async () => {
    const content = Buffer.alloc(20 * 1024 * 1024, 1).toString("base64");
    const request = post(
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "create_draft",
          arguments: { attachments: [{ filename: "a.bin", content }] },
        },
      },
      "good-token",
    );

    const response = await POST(request, context);

    expect(response.status).toBe(200);
    expect((await response.json()).id).toBe(7);
    const args = toolHandler.mock.calls[0][1];
    expect(args.attachments[0].content).toHaveLength(content.length);
  });

  it("returns 413 for an authenticated body over the limit", async () => {
    const request = new NextRequest("http://localhost/mcp-server", {
      method: "POST",
      body: "x".repeat(40 * 1024 * 1024),
      headers: { Authorization: "Bearer good-token" },
    });

    const response = await POST(request, context);

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect((await response.json()).error.code).toBe(-32_600);
    expect(toolHandler).not.toHaveBeenCalled();
  });

  it("returns a JSON-RPC parse error for invalid JSON once authenticated", async () => {
    const request = new NextRequest("http://localhost/mcp-server", {
      method: "POST",
      body: "{nope",
      headers: { Authorization: "Bearer good-token" },
    });

    const response = await POST(request, context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32_700);
  });
});

function post(
  body: unknown,
  token?: string,
  extraHeaders: Record<string, string | undefined> = {},
) {
  const headers: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};
  for (const [name, value] of Object.entries(extraHeaders)) {
    if (value !== undefined) headers[name] = value;
  }
  return new NextRequest("http://localhost/mcp-server", {
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
}
