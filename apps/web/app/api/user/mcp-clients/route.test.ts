import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { DELETE, GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", () => ({
  withAuth:
    (_scope: string, handler: (request: any) => Promise<Response>) =>
    (request: any) =>
      handler(request),
}));

const context = { params: Promise.resolve({}) };

describe("GET /api/user/mcp-clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findMany.mockResolvedValue([]);
  });

  it("asks only for MCP clients where this user still holds a live token", async () => {
    await GET(request(), context);

    expect(prisma.mcpServerClient.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          type: "MCP",
          accessTokens: { some: { userId: "user-1", revoked: false } },
        },
      }),
    );
  });

  it("counts only this user's tokens toward last used", async () => {
    await GET(request(), context);

    const select = prisma.mcpServerClient.findMany.mock.calls[0][0]?.select;
    expect(select?.accessTokens).toEqual({
      where: { userId: "user-1" },
      select: { lastUsedAt: true },
    });
  });

  it("returns the name, logo, host and the latest use, without the redirect URIs", async () => {
    prisma.mcpServerClient.findMany.mockResolvedValue([
      {
        clientId: "https://app.example.com/client.json",
        clientName: "Example",
        logoUri: "https://app.example.com/logo.png",
        redirectUris: ["https://other.example/cb"],
        accessTokens: [
          { lastUsedAt: new Date("2026-11-01T00:00:00Z") },
          { lastUsedAt: null },
          { lastUsedAt: new Date("2026-11-10T00:00:00Z") },
        ],
      },
      {
        clientId: "mcp_abc",
        clientName: "Local tool",
        logoUri: null,
        redirectUris: ["http://127.0.0.1:3000/callback"],
        accessTokens: [{ lastUsedAt: null }],
      },
    ] as any);

    const body = await (await GET(request(), context)).json();

    expect(body.mcpClients).toEqual([
      {
        clientId: "https://app.example.com/client.json",
        clientName: "Example",
        logoUri: "https://app.example.com/logo.png",
        host: "app.example.com",
        lastUsedAt: "2026-11-10T00:00:00.000Z",
      },
      {
        clientId: "mcp_abc",
        clientName: "Local tool",
        logoUri: null,
        host: "127.0.0.1:3000",
        lastUsedAt: null,
      },
    ]);
  });
});

describe("DELETE /api/user/mcp-clients", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 2 });
  });

  it("revokes only this user's live tokens for those MCP clients, as a user revoke", async () => {
    const response = await DELETE(request({ clientIds: ["c1"] }), context);

    expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        clientId: { in: ["c1"] },
        client: { type: "MCP" },
        revoked: false,
      },
      data: {
        revoked: true,
        revokedAt: expect.any(Date),
        revokedReason: "user",
      },
    });
    expect(await response.json()).toEqual({ revoked: 2 });
  });

  it("never deletes the client row, which other users' tokens depend on", async () => {
    await DELETE(request({ clientIds: ["c1"] }), context);

    expect(prisma.mcpServerClient.deleteMany).not.toHaveBeenCalled();
    expect(prisma.mcpServerClient.delete).not.toHaveBeenCalled();
  });

  it.each([
    [{}],
    [{ clientIds: [] }],
    [{ clientIds: "c1" }],
  ])("rejects %j with 400 and revokes nothing", async (body) => {
    const response = await DELETE(request(body), context);

    expect(response.status).toBe(400);
    expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
  });
});

function request(body: unknown = {}) {
  return {
    auth: { userId: "user-1" },
    json: async () => body,
  } as any;
}
