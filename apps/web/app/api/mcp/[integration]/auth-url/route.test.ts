import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { OWNER_ONLY_MESSAGE } from "@/utils/email-account-access";

const { authState } = vi.hoisted(() => ({
  authState: { actorUserId: "owner" },
}));

vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-auth-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithEmailAccountTestMiddleware({
    auth: {
      userId: "owner",
      get actorUserId() {
        return authState.actorUserId;
      },
      emailAccountId: "acct-1",
      email: "mailbox@example.com",
    },
  });
});
const { resolveMcpIntegrationMock } = vi.hoisted(() => ({
  resolveMcpIntegrationMock: vi.fn(),
}));

vi.mock("@/utils/mcp/tier-access", () => ({
  assertIntegrationsTierAccess: vi.fn(),
}));
vi.mock("@/utils/mcp/resolve-integration", () => ({
  resolveMcpIntegration: resolveMcpIntegrationMock,
}));
vi.mock("@/utils/mcp/oauth", () => ({
  generateOAuthUrl: async () => ({
    url: "https://auth.example.com/authorize",
    codeVerifier: "verifier",
  }),
}));

import { GET } from "./route";

describe("GET /api/mcp/notion/auth-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.actorUserId = "owner";
    resolveMcpIntegrationMock.mockResolvedValue({ authType: "oauth" });
  });

  it("refuses a user the mailbox is shared with", async () => {
    authState.actorUserId = "shared-user";

    const response = await callRoute();

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: OWNER_ONLY_MESSAGE,
    });
  });

  it("gives the owner an authorize URL", async () => {
    const response = await callRoute();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://auth.example.com/authorize",
    });
  });
});

function callRoute() {
  return GET(new NextRequest("http://localhost:3000/api/mcp/notion/auth-url"), {
    params: Promise.resolve({ integration: "notion" }),
  } as never);
}
