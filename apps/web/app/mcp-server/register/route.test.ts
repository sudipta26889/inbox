import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkIpRateLimit } from "@/utils/a2a/rate-limit";
import prisma from "@/utils/prisma";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/prisma", () => ({
  default: { mcpServerClient: { create: vi.fn() } },
}));
vi.mock("@/utils/a2a/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/a2a/rate-limit")>()),
  checkIpRateLimit: vi.fn(),
}));

const context = { params: Promise.resolve({}) };
const allowed = {
  allowed: true,
  limit: 20,
  remaining: 19,
  resetAt: new Date(),
};
const validBody = JSON.stringify({ redirect_uris: ["http://localhost/cb"] });

describe("POST /mcp-server/register", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(checkIpRateLimit).mockResolvedValue(allowed as never);
    vi.mocked(prisma.mcpServerClient.create).mockResolvedValue({
      clientId: "mcp_x",
      createdAt: new Date(),
      redirectUris: ["http://localhost/cb"],
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none",
      clientName: "MCP Client",
    } as never);
  });

  it("returns 413 over 16 KB without creating a client", async () => {
    const response = await POST(post("x".repeat(16 * 1024 + 1)), context);

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(prisma.mcpServerClient.create).not.toHaveBeenCalled();
  });

  it("returns 429 before reading the body when the IP is limited", async () => {
    vi.mocked(checkIpRateLimit).mockResolvedValue({
      ...allowed,
      allowed: false,
      remaining: 0,
      retryAfter: 30,
    } as never);
    const request = post(validBody);

    const response = await POST(request, context);

    expect(response.status).toBe(429);
    expect(request.bodyUsed).toBe(false);
  });

  it("buckets on X-Real-IP whatever the first X-Forwarded-For entry is", async () => {
    await POST(
      post(validBody, {
        "X-Forwarded-For": "1.1.1.1, 9.9.9.9",
        "X-Real-IP": "9.9.9.9",
      }),
      context,
    );

    expect(checkIpRateLimit).toHaveBeenCalledWith("9.9.9.9");
  });

  it("still registers a client under the limit", async () => {
    const response = await POST(post(validBody), context);

    expect(response.status).toBe(201);
    expect((await response.json()).client_id).toBe("mcp_x");
  });

  it("refuses a redirect URI with a scheme no client uses", async () => {
    const response = await POST(
      post(JSON.stringify({ redirect_uris: ["ftp://example.com/cb"] })),
      context,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_redirect_uri");
    expect(prisma.mcpServerClient.create).not.toHaveBeenCalled();
  });

  it("refuses the whole registration if one redirect URI is bad", async () => {
    const response = await POST(
      post(
        JSON.stringify({
          redirect_uris: ["http://localhost/cb", "http://evil.example/cb"],
        }),
      ),
      context,
    );

    expect(response.status).toBe(400);
    expect(prisma.mcpServerClient.create).not.toHaveBeenCalled();
  });

  it.each([
    [123],
    [null],
    [{ href: "http://localhost/cb" }],
  ])("refuses a redirect_uris entry that is not a string (%j)", async (entry) => {
    const response = await POST(
      post(JSON.stringify({ redirect_uris: ["http://localhost/cb", entry] })),
      context,
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_redirect_uri");
    expect(prisma.mcpServerClient.create).not.toHaveBeenCalled();
  });

  it("accepts a cursor:// redirect URI", async () => {
    const response = await POST(
      post(
        JSON.stringify({
          redirect_uris: ["cursor://anysphere.cursor-retrieval/oauth/callback"],
        }),
      ),
      context,
    );

    expect(response.status).toBe(201);
  });

  it("stores and reports auth method none even when the client asks for a secret", async () => {
    const response = await POST(
      post(
        JSON.stringify({
          redirect_uris: ["http://localhost/cb"],
          token_endpoint_auth_method: "client_secret_post",
        }),
      ),
      context,
    );

    expect(response.status).toBe(201);
    expect((await response.json()).token_endpoint_auth_method).toBe("none");
    expect(prisma.mcpServerClient.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tokenEndpointAuthMethod: "none" }),
    });
  });
});

function post(body: string, headers?: Record<string, string>) {
  return new NextRequest("http://localhost/mcp-server/register", {
    method: "POST",
    body,
    headers,
  });
}
