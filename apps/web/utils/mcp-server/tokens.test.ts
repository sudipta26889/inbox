import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  createJwtToken,
  generateAccessToken,
  refreshAccessToken,
  verifyJwtToken,
} from "./tokens";
import { MCP_RESOURCE } from "./constants";

vi.mock("@/utils/prisma");

const SECRET = "test-secret";

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ email: "user@test.com" } as any);
  });

  it("issues exactly one new token pair when the same refresh token is used twice at once", async () => {
    let claimedOnce = false;
    prisma.mcpServerAccessToken.updateMany.mockImplementation((async () => {
      const count = claimedOnce ? 0 : 1;
      claimedOnce = true;
      return { count };
    }) as any);

    const refreshToken = makeRefreshToken();
    const results = await Promise.all([
      refreshAccessToken(refreshToken, SECRET),
      refreshAccessToken(refreshToken, SECRET),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(prisma.mcpServerAccessToken.create).toHaveBeenCalledTimes(1);
  });

  it("rejects a refresh token that is already revoked without issuing tokens", async () => {
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 0 });

    const result = await refreshAccessToken(makeRefreshToken(), SECRET);

    expect(result).toBeNull();
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });

  it("revokes only the presented, still-live refresh token", async () => {
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 1 });

    const result = await refreshAccessToken(
      makeRefreshToken("refresh-jti"),
      SECRET,
    );

    expect(result?.refreshToken).toBeTruthy();
    expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { refreshToken: "refresh-jti", revoked: false },
      }),
    );
  });
});

function makeRefreshToken(jti = "refresh-jti") {
  const now = Math.floor(Date.now() / 1000);
  return createJwtToken(
    {
      sub: "user-1",
      email: "user@test.com",
      email_account_id: "account-1",
      scope: "email:read",
      client_id: "client-1",
      exp: now + 3600,
      iat: now,
      jti,
      token_type: "refresh",
    },
    SECRET,
  );
}

describe("generateAccessToken", () => {
  it("stamps the MCP resource as audience on both the access and refresh token", async () => {
    prisma.user.findUnique.mockResolvedValue({ email: "user@test.com" } as any);

    const { accessToken, refreshToken } = await generateAccessToken({
      userId: "user-1",
      emailAccountId: "account-1",
      clientId: "client-1",
      scope: "email:read",
      jwtSecret: SECRET,
    });

    expect(verifyJwtToken(accessToken, SECRET)?.aud).toBe(MCP_RESOURCE);
    expect(verifyJwtToken(refreshToken, SECRET)?.aud).toBe(MCP_RESOURCE);
  });
});
