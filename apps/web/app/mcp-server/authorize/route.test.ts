import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { BASE, MCP_RESOURCE } from "@/utils/mcp-server/constants";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));

const context = { params: Promise.resolve({}) };
const REGISTERED = "http://127.0.0.1:3000/callback";

describe("GET /mcp-server/authorize", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findUnique.mockResolvedValue({
      clientId: "client-1",
      clientName: "Test",
      logoUri: null,
      redirectUris: [REGISTERED],
    } as any);
    vi.mocked(auth).mockResolvedValue({ user: { id: "user-1" } } as never);
    prisma.user.findUnique.mockResolvedValue({
      id: "user-1",
      emailAccounts: [{ id: "account-1", email: "a@test.com" }],
    } as any);
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue({
      id: "existing",
    } as any);
  });

  it("rejects the plain code challenge method", async () => {
    const response = await GET(
      authorize({ code_challenge_method: "plain" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("invalid_request");
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("rejects a resource that is not this server with invalid_target", async () => {
    const response = await GET(
      authorize({ resource: "https://other.example/mcp-server" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(JSON.stringify(await response.json())).toContain("invalid_target");
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("rejects a redirect_uri the client never registered", async () => {
    const response = await GET(
      authorize({ redirect_uri: "https://evil.example/cb" }),
      context,
    );

    expect(response.status).toBe(400);
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("accepts a loopback redirect_uri on another port, and skips consent for a prior approval", async () => {
    const redirectUri = "http://127.0.0.1:54321/callback";

    const response = await GET(
      authorize({ redirect_uri: redirectUri, resource: MCP_RESOURCE }),
      context,
    );

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location")!);
    expect(`${location.origin}${location.pathname}`).toBe(redirectUri);
    expect(location.searchParams.get("code")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe("st");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(prisma.mcpServerAuthorizationCode.create).toHaveBeenCalledTimes(1);
  });

  it("sends a user with no prior approval to the consent page, not back to the client", async () => {
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue(null);

    const response = await GET(authorize({}), context);

    expect(new URL(response.headers.get("location")!).pathname).toBe(
      "/mcp-server/consent",
    );
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });
});

function authorize(overrides: Record<string, string>) {
  const params = new URLSearchParams({
    client_id: "client-1",
    redirect_uri: REGISTERED,
    response_type: "code",
    scope: "email:read",
    state: "st",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    ...overrides,
  });
  return new NextRequest(`${BASE}/mcp-server/authorize?${params}`);
}
