import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { BASE } from "@/utils/mcp-server/constants";
import { OPTIONS, POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", () => ({
  withAuth:
    (_scope: string, handler: (request: any) => Promise<Response>) =>
    (request: any) =>
      handler(request),
}));

const context = { params: Promise.resolve({}) };
const REDIRECT = "http://127.0.0.1:3000/callback";

describe("POST /mcp-server/consent/approve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpServerClient.findUnique.mockResolvedValue({
      clientId: "client-1",
      redirectUris: [REDIRECT],
      scope: null,
    } as any);
    prisma.emailAccount.findFirst.mockResolvedValue({ id: "account-1" } as any);
  });

  it("rejects a foreign Origin with 403 before doing anything", async () => {
    const response = await POST(
      request({ origin: "https://evil.example" }),
      context,
    );

    expect(response.status).toBe(403);
    expect(prisma.mcpServerClient.findUnique).not.toHaveBeenCalled();
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin", async () => {
    const response = await POST(request({ origin: null }), context);

    expect(response.status).toBe(403);
  });

  it("refuses an email code session, issuing no code", async () => {
    const response = await POST(request({ emailOtp: true }), context);

    expect(response.status).toBe(403);
    expect((await response.json()).error_description).toContain(
      "Email code sign-in can't authorize apps",
    );
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("approves from the server's own origin and returns a redirect with a code and issuer", async () => {
    const response = await POST(request({}), context);

    expect(response.status).toBe(200);
    const url = new URL((await response.json()).redirectUrl);
    expect(url.searchParams.get("code")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("iss")).toBe(BASE);
    expect(prisma.mcpServerAuthorizationCode.create).toHaveBeenCalledTimes(1);
  });

  it("denies through the server with access_denied, state and issuer, issuing no code", async () => {
    const response = await POST(request({ body: { deny: true } }), context);

    const url = new URL((await response.json()).redirectUrl);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("st");
    expect(url.searchParams.get("iss")).toBe(BASE);
    expect(url.searchParams.has("code")).toBe(false);
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("will not deny to a redirect the client never registered", async () => {
    await expect(
      POST(
        request({
          body: { deny: true, redirect_uri: "https://evil.example/cb" },
        }),
        context,
      ),
    ).rejects.toThrow();
  });

  it("will not approve a redirect the client never registered", async () => {
    await expect(
      POST(
        request({ body: { redirect_uri: "https://evil.example/cb" } }),
        context,
      ),
    ).rejects.toThrow();
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("refuses a scope outside the client's registered scope", async () => {
    prisma.mcpServerClient.findUnique.mockResolvedValue({
      clientId: "client-1",
      redirectUris: [REDIRECT],
      scope: "email:read",
    } as any);

    await expect(
      POST(request({ body: { scope: "email:read email:write" } }), context),
    ).rejects.toThrow("Invalid scope");
  });

  it.each([
    "short",
    `${"c".repeat(42)}!`,
    "c".repeat(44),
  ])("refuses a malformed code_challenge %j", async (codeChallenge) => {
    await expect(
      POST(request({ body: { code_challenge: codeChallenge } }), context),
    ).rejects.toThrow("invalid_request");
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("refuses a plain code challenge instead of storing it", async () => {
    await expect(
      POST(request({ body: { code_challenge_method: "plain" } }), context),
    ).rejects.toThrow("invalid_request");
    expect(prisma.mcpServerAuthorizationCode.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown scope", async () => {
    await expect(
      POST(request({ body: { scope: "not:a:scope" } }), context),
    ).rejects.toThrow("Invalid scope");
  });

  it("answers the preflight without CORS headers", async () => {
    const response = await OPTIONS();

    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });
});

function request({
  origin = BASE,
  body = {},
  emailOtp,
}: {
  origin?: string | null;
  body?: Record<string, unknown>;
  emailOtp?: boolean;
}) {
  const headers = new Headers();
  if (origin) headers.set("Origin", origin);
  return {
    headers,
    auth: { userId: "user-1", ...(emailOtp ? { emailOtp } : {}) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    json: async () => ({
      client_id: "client-1",
      redirect_uri: REDIRECT,
      scope: "email:read",
      state: "st",
      code_challenge: "c".repeat(43),
      code_challenge_method: "S256",
      email_account_id: "account-1",
      ...body,
    }),
  } as any;
}
