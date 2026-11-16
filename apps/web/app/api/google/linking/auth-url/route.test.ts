import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthState,
  mockGenerateAuthUrl,
  mockHasActiveAccountLinkingUser,
  mockFindReconnectTarget,
} = vi.hoisted(() => ({
  mockAuthState: { userId: "user-1" } as { userId: string; emailOtp?: boolean },
  mockGenerateAuthUrl: vi.fn(() => "https://accounts.google.com/o/oauth2/auth"),
  mockHasActiveAccountLinkingUser: vi.fn(),
  mockFindReconnectTarget: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-auth-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithAuthTestMiddleware({ auth: mockAuthState });
});

vi.mock("@/utils/gmail/client", () => ({
  getLinkingOAuth2Client: vi.fn(() => ({
    generateAuthUrl: mockGenerateAuthUrl,
  })),
}));

vi.mock("@/utils/oauth/account-linking", () => ({
  hasActiveAccountLinkingUser: mockHasActiveAccountLinkingUser,
}));

vi.mock("@/utils/oauth/reconnect-target", () => ({
  findReconnectTarget: mockFindReconnectTarget,
}));

import { parseSignedOAuthState } from "@/utils/oauth/state";
import { GET } from "./route";

describe("google linking auth-url route", () => {
  const createRequest = () =>
    new NextRequest("http://localhost:3000/api/google/linking/auth-url");

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthState.emailOtp = undefined;
    mockHasActiveAccountLinkingUser.mockResolvedValue(true);
  });

  it("returns an auth URL for a provider session", async () => {
    const response = await GET(createRequest(), {} as never);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      url: "https://accounts.google.com/o/oauth2/auth",
    });
  });

  it("lets an email code session start mailbox linking", async () => {
    mockAuthState.emailOtp = true;

    const response = await GET(createRequest(), {} as never);

    expect(response.status).toBe(200);
    expect(mockGenerateAuthUrl).toHaveBeenCalled();
  });

  it("links a shared mailbox as its owner so the callback refreshes tokens", async () => {
    mockFindReconnectTarget.mockResolvedValue({
      id: "mailbox-1",
      email: "mailbox@example.com",
      userId: "owner-1",
    });

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/google/linking/auth-url?emailAccountId=mailbox-1",
      ),
      {} as never,
    );

    expect(response.status).toBe(200);
    expect(mockFindReconnectTarget).toHaveBeenCalledWith({
      emailAccountId: "mailbox-1",
      userId: "user-1",
      provider: "google",
    });
    const cookie = response.cookies.get("google_linking_state")?.value;
    const state = parseSignedOAuthState<{
      userId: string;
      reconnectEmailAccountId: string;
    }>(cookie as string);
    expect(state.userId).toBe("owner-1");
    expect(state.reconnectEmailAccountId).toBe("mailbox-1");
  });

  it("refuses a reconnect for a mailbox the user can't access", async () => {
    mockFindReconnectTarget.mockResolvedValue(null);

    const response = await GET(
      new NextRequest(
        "http://localhost:3000/api/google/linking/auth-url?emailAccountId=mailbox-1",
      ),
      {} as never,
    );

    expect(response.status).toBe(404);
  });
});
