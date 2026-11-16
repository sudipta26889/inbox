import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  // Real env for everything the route imports; only the health key varies.
  Object.assign(mockEnv, actual.env);
  return { env: mockEnv };
});

const context = { params: Promise.resolve({}) };

describe("GET /api/health/accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.HEALTH_API_KEY = "health-key";
  });

  it("fails closed when no health key is configured", async () => {
    mockEnv.HEALTH_API_KEY = undefined;
    const response = await GET(request("anything"), context);
    expect(response.status).toBe(503);
  });

  it("rejects a wrong key without listing mailboxes", async () => {
    const response = await GET(request("wrong"), context);
    expect(response.status).toBe(401);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it("reports which mailboxes lost their grant", async () => {
    const disconnectedAt = new Date("2026-10-07T13:14:32Z");
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "ea-1",
        email: "ok@example.com",
        watchEmailsExpirationDate: new Date("2026-10-20T02:34:23Z"),
        account: {
          provider: "google",
          disconnectedAt: null,
          refresh_token: "r",
        },
        calendarConnections: [],
      },
      {
        id: "ea-2",
        email: "revoked@example.com",
        watchEmailsExpirationDate: null,
        account: { provider: "google", disconnectedAt, refresh_token: "r" },
        calendarConnections: [],
      },
    ] as never);

    const response = await GET(request("health-key"), context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connectedCount: 1, disconnectedCount: 1 });
    expect(body.accounts[0].watchExpiresAt).toBe("2026-10-20T02:34:23.000Z");
    expect(body.accounts[1]).toMatchObject({
      email: "revoked@example.com",
      connected: false,
      disconnectedAt: disconnectedAt.toISOString(),
    });
  });

  it("treats a wiped refresh token as disconnected and flags expired calendars", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "ea-3",
        email: "wiped@example.com",
        watchEmailsExpirationDate: null,
        account: {
          provider: "google",
          disconnectedAt: null,
          refresh_token: null,
        },
        calendarConnections: [{ isConnected: true, refreshToken: null }],
      },
    ] as never);

    const body = await (await GET(request("health-key"), context)).json();

    expect(body).toMatchObject({ connectedCount: 0, disconnectedCount: 1 });
    expect(body.accounts[0]).toMatchObject({
      connected: false,
      calendarConnected: false,
    });
    expect(body.accounts[0]).not.toHaveProperty("refresh_token");
  });
});

function request(key: string) {
  return new NextRequest("http://localhost/api/health/accounts", {
    headers: { "x-health-api-key": key },
  });
}
