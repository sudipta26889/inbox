import crypto from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  hashAuthorizationCode,
  isMcpResource,
  issueAuthorizationCode,
} from "./authorization-code";
import { BASE, MCP_RESOURCE, TOKEN_CONFIG } from "./constants";

vi.mock("@/utils/prisma");

const input = {
  userId: "user-1",
  emailAccountId: "account-1",
  clientId: "client-1",
  redirectUri: "http://127.0.0.1:3000/callback",
  scope: "email:read",
  state: "abc",
  codeChallenge: "challenge",
  codeChallengeMethod: "S256",
};

describe("issueAuthorizationCode", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stores only the sha256 hex of the code it hands to the client", async () => {
    const redirect = new URL(await issueAuthorizationCode(input));

    const code = redirect.searchParams.get("code");
    const stored =
      prisma.mcpServerAuthorizationCode.create.mock.calls[0][0].data.code;
    expect(code).toBeTruthy();
    expect(stored).not.toBe(code);
    expect(stored).toBe(
      crypto.createHash("sha256").update(code!).digest("hex"),
    );
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns state and the issuer in the redirect", async () => {
    const redirect = new URL(await issueAuthorizationCode(input));

    expect(redirect.searchParams.get("state")).toBe("abc");
    expect(redirect.searchParams.get("iss")).toBe(BASE);
  });

  it("omits state when none was sent but still adds the issuer", async () => {
    const redirect = new URL(
      await issueAuthorizationCode({ ...input, state: "" }),
    );

    expect(redirect.searchParams.has("state")).toBe(false);
    expect(redirect.searchParams.get("iss")).toBe(BASE);
  });

  it("expires the code after the configured TTL and gives it a grant", async () => {
    const before = Date.now();
    await issueAuthorizationCode(input);

    const data = prisma.mcpServerAuthorizationCode.create.mock.calls[0][0].data;
    const ttlMs = new Date(data.expiresAt).getTime() - before;
    expect(TOKEN_CONFIG.AUTHORIZATION_CODE_TTL).toBe(300);
    expect(ttlMs).toBeGreaterThanOrEqual(299_000);
    expect(ttlMs).toBeLessThanOrEqual(301_000);
    expect(data.grantId).toBeTruthy();
  });
});

describe("hashAuthorizationCode", () => {
  it("is deterministic", () => {
    expect(hashAuthorizationCode("x")).toBe(hashAuthorizationCode("x"));
  });
});

describe("isMcpResource", () => {
  it("accepts the resource, with or without one trailing slash", () => {
    expect(isMcpResource(MCP_RESOURCE)).toBe(true);
    expect(isMcpResource(`${MCP_RESOURCE}/`)).toBe(true);
  });

  it("rejects anything else", () => {
    expect(isMcpResource(`${MCP_RESOURCE}//`)).toBe(false);
    expect(isMcpResource("https://other.example/mcp-server")).toBe(false);
    expect(isMcpResource(BASE)).toBe(false);
  });
});
