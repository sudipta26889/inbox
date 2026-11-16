import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import { createCodeChallenge } from "@/utils/mcp-server/pkce";
import { hashAuthorizationCode } from "@/utils/mcp-server/authorization-code";
import { MCP_RESOURCE } from "@/utils/mcp-server/constants";
import { createJwtToken } from "@/utils/mcp-server/tokens";
import { env } from "@/env";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: {
    mcpServerClient: { findUnique: vi.fn() },
    mcpServerAuthorizationCode: { updateMany: vi.fn(), findFirst: vi.fn() },
    mcpServerAccessToken: { updateMany: vi.fn(), create: vi.fn() },
    user: { findUnique: vi.fn() },
  },
}));

describe("POST /mcp-server/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.mcpServerClient.findUnique).mockResolvedValue(null);
  });

  it("returns 413 over 16 KB without looking up a client", async () => {
    const response = await POST(post(`grant_type=${"x".repeat(16 * 1024)}`));

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect((await response.json()).error).toBe("invalid_request");
    expect(prisma.mcpServerClient.findUnique).not.toHaveBeenCalled();
  });

  it("still parses a urlencoded form under the limit", async () => {
    const response = await POST(post("grant_type=refresh_token&client_id=abc"));

    expect((await response.json()).error).toBe("invalid_client");
    expect(prisma.mcpServerClient.findUnique).toHaveBeenCalledWith({
      where: { clientId: "abc" },
    });
  });
});

const VERIFIER = "v".repeat(50);
const CODE = "the-raw-code";

describe("authorization_code grant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.mcpServerClient.findUnique).mockResolvedValue({
      clientId: "client-1",
    } as never);
    vi.mocked(prisma.mcpServerAuthorizationCode.updateMany).mockResolvedValue({
      count: 1,
    });
    vi.mocked(prisma.mcpServerAuthorizationCode.findFirst).mockResolvedValue(
      codeRow() as never,
    );
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      email: "u@test.com",
    } as never);
  });

  it("claims the code by its hash, atomically, and issues tokens for the grant", async () => {
    const response = await POST(exchange());

    expect(response.status).toBe(200);
    expect(prisma.mcpServerAuthorizationCode.updateMany).toHaveBeenCalledWith({
      where: {
        code: hashAuthorizationCode(CODE),
        clientId: "client-1",
        used: false,
        expiresAt: { gt: expect.any(Date) },
      },
      data: { used: true, usedAt: expect.any(Date) },
    });
    expect(prisma.mcpServerAccessToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ grantId: "grant-1" }),
    });
  });

  it("accepts a loopback redirect_uri on another port", async () => {
    const response = await POST(
      exchange({ redirect_uri: "http://localhost:9999/callback" }),
    );

    expect(response.status).toBe(200);
  });

  it("rejects a redirect_uri that differs from the authorization request", async () => {
    const response = await POST(
      exchange({ redirect_uri: "http://127.0.0.1:3000/elsewhere" }),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });

  it("rejects a resource that is not this server with invalid_target", async () => {
    const response = await POST(
      exchange({ resource: "https://other.example/mcp-server" }),
    );

    expect((await response.json()).error).toBe("invalid_target");
    expect(prisma.mcpServerAuthorizationCode.updateMany).not.toHaveBeenCalled();
  });

  it("accepts this server as the resource", async () => {
    const response = await POST(exchange({ resource: MCP_RESOURCE }));

    expect(response.status).toBe(200);
  });

  it("revokes the grant's tokens when a used code is presented again", async () => {
    vi.mocked(prisma.mcpServerAuthorizationCode.updateMany).mockResolvedValue({
      count: 0,
    });
    vi.mocked(prisma.mcpServerAuthorizationCode.findFirst).mockResolvedValue(
      codeRow({ used: true }) as never,
    );
    vi.mocked(prisma.mcpServerAccessToken.updateMany).mockResolvedValue({
      count: 2,
    });

    const response = await POST(exchange());

    expect((await response.json()).error).toBe("invalid_grant");
    expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith({
      where: { grantId: "grant-1", revoked: false },
      data: expect.objectContaining({ revoked: true, revokedReason: "reuse" }),
    });
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });

  it("does not revoke anything for a code that merely expired", async () => {
    vi.mocked(prisma.mcpServerAuthorizationCode.updateMany).mockResolvedValue({
      count: 0,
    });
    vi.mocked(prisma.mcpServerAuthorizationCode.findFirst).mockResolvedValue(
      codeRow({ used: false }) as never,
    );

    const response = await POST(exchange());

    expect((await response.json()).error).toBe("invalid_grant");
    expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a wrong code_verifier", async () => {
    const response = await POST(exchange({ code_verifier: "w".repeat(50) }));

    expect((await response.json()).error).toBe("invalid_grant");
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });
});

describe("refresh_token grant", () => {
  it("answers invalid_grant when the token belongs to another client", async () => {
    vi.clearAllMocks();
    vi.mocked(prisma.mcpServerClient.findUnique).mockResolvedValue({
      clientId: "client-2",
    } as never);
    const now = Math.floor(Date.now() / 1000);
    const refreshToken = createJwtToken(
      {
        sub: "user-1",
        email: "u@test.com",
        email_account_id: "account-1",
        scope: "email:read",
        client_id: "client-1",
        exp: now + 3600,
        iat: now,
        jti: "refresh-jti",
        token_type: "refresh",
      },
      env.AUTH_SECRET || env.NEXTAUTH_SECRET || "",
    );

    const response = await POST(
      post(
        new URLSearchParams({
          grant_type: "refresh_token",
          client_id: "client-2",
          refresh_token: refreshToken,
        }).toString(),
      ),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_grant");
    expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });
});

function codeRow(overrides: Record<string, unknown> = {}) {
  return {
    used: false,
    grantId: "grant-1",
    redirectUri: "http://127.0.0.1:3000/callback",
    codeChallenge: createCodeChallenge(VERIFIER),
    codeChallengeMethod: "S256",
    scope: "email:read",
    userId: "user-1",
    emailAccountId: "account-1",
    ...overrides,
  };
}

function exchange(overrides: Record<string, string> = {}) {
  return post(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "client-1",
      code: CODE,
      code_verifier: VERIFIER,
      redirect_uri: "http://127.0.0.1:3000/callback",
      ...overrides,
    }).toString(),
  );
}

function post(body: string) {
  return new NextRequest("http://localhost/mcp-server/token", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
