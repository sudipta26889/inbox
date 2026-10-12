import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/gmail/client", () => ({
  getLinkingOAuth2Client: () => ({
    generateAuthUrl: (options: Record<string, string>) =>
      `https://accounts.google.example/auth?${new URLSearchParams(options)}`,
  }),
}));

const context = { params: Promise.resolve({}) };

describe("GET /api/google/linking/auth-url", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1", email: "owner@example.com" },
    } as never);
  });

  it("points a reconnect at its mailbox through the real auth wrapper", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "mailbox-1",
      email: "mailbox@example.com",
    } as never);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/google/linking/auth-url?emailAccountId=mailbox-1",
      ),
      context,
    );

    expect(response.status).toBe(200);
    const { url } = await response.json();
    expect(new URL(url).searchParams.get("login_hint")).toBe(
      "mailbox@example.com",
    );
  });

  it("refuses a reconnect for a mailbox the user doesn't own", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);

    const response = await GET(
      new NextRequest(
        "http://localhost/api/google/linking/auth-url?emailAccountId=someone-else",
      ),
      context,
    );

    expect(response.status).toBe(404);
  });

  it("leaves adding an account unconstrained", async () => {
    const response = await GET(
      new NextRequest("http://localhost/api/google/linking/auth-url"),
      context,
    );

    expect(response.status).toBe(200);
    const { url } = await response.json();
    expect(new URL(url).searchParams.get("login_hint")).toBeNull();
  });
});
