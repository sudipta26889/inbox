vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

const { getMcpServerAccessMock, listMcpConnectionsMock, authState } =
  vi.hoisted(() => ({
    getMcpServerAccessMock: vi.fn(),
    listMcpConnectionsMock: vi.fn(),
    authState: { actorUserId: "user_1" },
  }));

vi.mock("@/utils/prisma");
vi.mock("@/utils/mcp/access", () => ({
  getMcpServerAccess: getMcpServerAccessMock,
}));
vi.mock("@/utils/mcp/connections", () => ({
  listMcpConnections: listMcpConnectionsMock,
}));
vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _scope: string,
      handler: (request: NextRequest, ...args: unknown[]) => Promise<Response>,
    ) =>
    (request: NextRequest, ...args: unknown[]) => {
      const requestWithAuth = Object.assign(request, {
        auth: {
          userId: "user_1",
          actorUserId: authState.actorUserId,
          emailAccountId: "account_1",
          email: "user@example.com",
        },
      });

      return handler(requestWithAuth, ...args);
    },
}));

import { GET } from "./route";

describe("user/api-keys route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.apiKey.findMany.mockResolvedValue([
      {
        id: "key_1",
        name: "Management key",
        createdAt: new Date("2026-04-07T00:00:00.000Z"),
        expiresAt: null,
        lastUsedAt: null,
        scopes: ["RULES_READ"],
      },
    ] as never);
    getMcpServerAccessMock.mockResolvedValue({
      available: true,
      enabled: false,
    });
    prisma.oauthConsent.findMany.mockResolvedValue([]);
    listMcpConnectionsMock.mockResolvedValue([]);
    authState.actorUserId = "user_1";
  });

  it("returns API keys together with MCP access flags", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/user/api-keys"),
      {} as never,
    );

    await expect(response.json()).resolves.toEqual({
      apiKeys: [
        {
          id: "key_1",
          name: "Management key",
          createdAt: "2026-04-07T00:00:00.000Z",
          expiresAt: null,
          lastUsedAt: null,
          scopes: ["RULES_READ"],
        },
      ],
      mcpServerAvailable: true,
      mcpServerEnabled: false,
      mcpConnections: [],
    });
  });

  it("shows a shared user none of the owner's keys and only their own MCP connections", async () => {
    authState.actorUserId = "shared_user";
    getMcpServerAccessMock.mockResolvedValue({
      available: true,
      enabled: true,
    });
    listMcpConnectionsMock.mockResolvedValue([{ clientId: "theirs" }]);

    const response = await GET(
      new NextRequest("http://localhost:3000/api/user/api-keys"),
      {} as never,
    );

    await expect(response.json()).resolves.toMatchObject({
      apiKeys: [],
      mcpConnections: [{ clientId: "theirs" }],
    });
    expect(prisma.apiKey.findMany).not.toHaveBeenCalled();
    expect(getMcpServerAccessMock).toHaveBeenCalledWith("shared_user");
    expect(listMcpConnectionsMock).toHaveBeenCalledWith("shared_user");
  });
});
