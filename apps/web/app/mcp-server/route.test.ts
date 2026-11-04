import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { auth } from "@/utils/auth";
import { buildMcpToolContext } from "@/utils/mcp-server/tool-context";
import { validateAccessToken } from "@/utils/mcp-server/tokens";
import { POST } from "./route";

const { toolHandler } = vi.hoisted(() => ({ toolHandler: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: { emailAccount: { findMany: vi.fn(() => []) } },
}));
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
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
    vi.mocked(auth).mockResolvedValue(null as never);
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
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(request.bodyUsed).toBe(false);
    expect(JSON.stringify(log.mock.calls)).not.toContain(METHOD_MARKER);
  });

  it("returns 401 for an invalid token, without reading the body", async () => {
    vi.mocked(validateAccessToken).mockResolvedValue(null as never);
    const request = post(
      { jsonrpc: "2.0", id: 1, method: METHOD_MARKER },
      "bad-token",
    );

    const response = await POST(request, context);

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'error="invalid_token"',
    );
    expect(request.bodyUsed).toBe(false);
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

function post(body: unknown, token?: string) {
  return new NextRequest("http://localhost/mcp-server", {
    method: "POST",
    body: JSON.stringify(body),
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
}
