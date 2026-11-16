import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { OWNER_ONLY_MESSAGE } from "@/utils/email-account-access";

const { authState } = vi.hoisted(() => ({
  authState: { actorUserId: "owner" },
}));

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: {
    SLACK_CLIENT_ID: "client",
    SLACK_CLIENT_SECRET: "secret",
    AUTH_SECRET: "test-auth-secret",
    NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  },
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return {
    withEmailAccount: (scope: string, handler: never) =>
      createWithEmailAccountTestMiddleware({
        auth: {
          userId: "owner",
          get actorUserId() {
            return authState.actorUserId;
          },
          emailAccountId: "acct-1",
          email: "mailbox@example.com",
        },
      }).withEmailAccount(scope, handler),
  };
});

import { GET } from "./route";

describe("GET /api/slack/auth-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authState.actorUserId = "owner";
    prisma.emailAccount.findUnique.mockResolvedValue(null);
    prisma.member.findFirst.mockResolvedValue(null);
  });

  it("refuses a user the mailbox is shared with", async () => {
    authState.actorUserId = "shared-user";

    const response = await GET(
      new NextRequest("http://localhost:3000/api/slack/auth-url"),
      {} as never,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: OWNER_ONLY_MESSAGE,
    });
  });

  it("gives the owner a Slack authorize URL", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/slack/auth-url"),
      {} as never,
    );

    expect(response.status).toBe(200);
    const { url } = await response.json();
    expect(url).toContain("slack.com");
  });
});
