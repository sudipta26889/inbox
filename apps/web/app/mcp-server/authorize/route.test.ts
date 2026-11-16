import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { BASE, MCP_RESOURCE } from "@/utils/mcp-server/constants";
import { resolveClientMetadata } from "@/utils/mcp-server/client-metadata";
import { checkIpRateLimit } from "@/utils/a2a/rate-limit";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/mcp-server/client-metadata", () => ({
  resolveClientMetadata: vi.fn(),
}));
vi.mock("@/utils/a2a/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/a2a/rate-limit")>()),
  checkIpRateLimit: vi.fn(),
}));

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

  it.each([
    "short",
    `${"c".repeat(42)}!`,
    "c".repeat(44),
  ])("rejects a malformed code_challenge %j", async (codeChallenge) => {
    const response = await GET(
      authorize({ code_challenge: codeChallenge }),
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

  describe("a client_id that is a metadata URL", () => {
    const CIMD = "https://app.example.com/client.json";

    beforeEach(() => {
      vi.mocked(checkIpRateLimit).mockResolvedValue({
        allowed: true,
        limit: 20,
        remaining: 19,
        resetAt: new Date(),
      } as never);
      vi.mocked(resolveClientMetadata).mockResolvedValue({
        clientId: CIMD,
      } as never);
    });

    it("sends an anonymous user to sign in without fetching or looking anything up", async () => {
      vi.mocked(auth).mockResolvedValue(null as never);

      const response = await GET(authorize({ client_id: CIMD }), context);

      const login = new URL(response.headers.get("location")!);
      expect(login.pathname).toBe("/login");
      expect(login.searchParams.has("callbackUrl")).toBe(false);
      // The login page reads `next` and accepts only a relative path.
      const next = login.searchParams.get("next")!;
      expect(next.startsWith("/mcp-server/authorize?oauth_state=")).toBe(true);
      const resumed = new URLSearchParams(
        Buffer.from(
          new URLSearchParams(next.split("?")[1]).get("oauth_state")!,
          "base64url",
        ).toString(),
      );
      expect(resumed.get("client_id")).toBe(CIMD);
      expect(resumed.get("state")).toBe("st");
      expect(resolveClientMetadata).not.toHaveBeenCalled();
      expect(checkIpRateLimit).not.toHaveBeenCalled();
      expect(prisma.mcpServerClient.findUnique).not.toHaveBeenCalled();
    });

    it("resolves the metadata once the user is signed in", async () => {
      await GET(authorize({ client_id: CIMD }), context);

      expect(resolveClientMetadata).toHaveBeenCalledWith(CIMD, REGISTERED);
      expect(prisma.mcpServerClient.findUnique).not.toHaveBeenCalled();
    });

    it("answers 429 and does not fetch when the IP is rate limited", async () => {
      vi.mocked(checkIpRateLimit).mockResolvedValue({
        allowed: false,
        limit: 20,
        remaining: 0,
        resetAt: new Date(),
        retryAfter: 30,
      } as never);

      const response = await GET(authorize({ client_id: CIMD }), context);

      expect(response.status).toBe(429);
      expect(resolveClientMetadata).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["with a prior approval (skip-consent path)", { id: "existing" }],
    ["without a prior approval", null],
  ])("refuses an email code session %s, issuing no code", async (_label, approval) => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1" },
      session: { emailOtp: true },
    } as never);
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue(approval as never);

    const response = await GET(authorize({}), context);

    expect(response.status).toBe(403);
    expect((await response.json()).error_description).toContain(
      "Email code sign-in can't authorize apps",
    );
    expect(response.headers.get("location")).toBeNull();
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
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
    code_challenge: "c".repeat(43),
    code_challenge_method: "S256",
    ...overrides,
  });
  return new NextRequest(`${BASE}/mcp-server/authorize?${params}`);
}
