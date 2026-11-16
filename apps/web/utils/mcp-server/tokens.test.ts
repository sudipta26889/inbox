import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  createJwtToken,
  generateAccessToken,
  refreshAccessToken,
  revokeAccessToken,
  verifyJwtToken,
} from "./tokens";
import { MCP_RESOURCE } from "./constants";

vi.mock("@/utils/prisma");

const SECRET = "test-secret";

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({ email: "user@test.com" } as any);
    prisma.emailAccount.findFirst.mockResolvedValue({ id: "account-1" } as any);
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue(liveRow() as any);
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
      refreshAccessToken(refreshToken, SECRET, "client-1"),
      refreshAccessToken(refreshToken, SECRET, "client-1"),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(prisma.mcpServerAccessToken.create).toHaveBeenCalledTimes(1);
  });

  it("rotates the presented token and carries the grant to the new one", async () => {
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 1 });

    const result = await refreshAccessToken(
      makeRefreshToken("refresh-jti"),
      SECRET,
      "client-1",
    );

    expect(result?.refreshToken).toBeTruthy();
    expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { refreshToken: "refresh-jti", revoked: false },
        data: expect.objectContaining({
          revoked: true,
          revokedReason: "rotated",
        }),
      }),
    );
    expect(prisma.mcpServerAccessToken.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ grantId: "grant-1" }),
    });
  });

  it("gives a grant issued before grantId existed a fresh one on refresh", async () => {
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue({
      ...liveRow(),
      grantId: null,
    } as any);
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 1 });

    await refreshAccessToken(makeRefreshToken(), SECRET, "client-1");

    const data = prisma.mcpServerAccessToken.create.mock.calls[0][0].data;
    expect(data.grantId).toEqual(expect.any(String));
    expect(data.grantId).not.toBe("");
  });

  it("refuses a different client without revoking anything", async () => {
    const result = await refreshAccessToken(
      makeRefreshToken(),
      SECRET,
      "other-client",
    );

    expect(result).toBeNull();
    expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });

  it("refuses, without rotating, when the user lost access to the account", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);

    const result = await refreshAccessToken(
      makeRefreshToken(),
      SECRET,
      "client-1",
    );

    expect(result).toBeNull();
    expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });

  describe("a rotated token presented again", () => {
    it("revokes the whole grant after the grace window (31 s)", async () => {
      prisma.mcpServerAccessToken.findFirst.mockResolvedValue(
        rotatedRow(31) as any,
      );
      prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 1 });

      const result = await refreshAccessToken(
        makeRefreshToken(),
        SECRET,
        "client-1",
      );

      expect(result).toBeNull();
      expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith({
        where: { grantId: "grant-1", revoked: false },
        data: expect.objectContaining({
          revoked: true,
          revokedReason: "reuse",
        }),
      });
      expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
    });

    it("only refuses inside the grace window (10 s)", async () => {
      prisma.mcpServerAccessToken.findFirst.mockResolvedValue(
        rotatedRow(10) as any,
      );

      const result = await refreshAccessToken(
        makeRefreshToken(),
        SECRET,
        "client-1",
      );

      expect(result).toBeNull();
      expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    });

    it("leaves a grant without an id alone", async () => {
      prisma.mcpServerAccessToken.findFirst.mockResolvedValue({
        ...rotatedRow(120),
        grantId: null,
      } as any);

      const result = await refreshAccessToken(
        makeRefreshToken(),
        SECRET,
        "client-1",
      );

      expect(result).toBeNull();
      expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    });

    it.each([
      "user",
      "admin",
      "reuse",
    ])("does nothing more for a token revoked as %s", async (revokedReason) => {
      prisma.mcpServerAccessToken.findFirst.mockResolvedValue({
        ...rotatedRow(120),
        revokedReason,
      } as any);

      const result = await refreshAccessToken(
        makeRefreshToken(),
        SECRET,
        "client-1",
      );

      expect(result).toBeNull();
      expect(prisma.mcpServerAccessToken.updateMany).not.toHaveBeenCalled();
    });
  });

  it("rejects an unknown refresh token", async () => {
    prisma.mcpServerAccessToken.findFirst.mockResolvedValue(null);

    const result = await refreshAccessToken(
      makeRefreshToken(),
      SECRET,
      "client-1",
    );

    expect(result).toBeNull();
    expect(prisma.mcpServerAccessToken.create).not.toHaveBeenCalled();
  });
});

describe("revokeAccessToken", () => {
  it("records that the user revoked it", async () => {
    prisma.mcpServerAccessToken.updateMany.mockResolvedValue({ count: 1 });
    const now = Math.floor(Date.now() / 1000);
    const token = createJwtToken(
      {
        sub: "user-1",
        email: "user@test.com",
        email_account_id: "account-1",
        scope: "email:read",
        client_id: "client-1",
        exp: now + 3600,
        iat: now,
        jti: "access-jti",
        token_type: "access",
      },
      SECRET,
    );

    await revokeAccessToken(token, SECRET);

    expect(prisma.mcpServerAccessToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ revokedReason: "user" }),
      }),
    );
  });
});

function liveRow() {
  return {
    revoked: false,
    revokedReason: null,
    revokedAt: null,
    grantId: "grant-1",
  };
}

function rotatedRow(secondsAgo: number) {
  return {
    revoked: true,
    revokedReason: "rotated",
    revokedAt: new Date(Date.now() - secondsAgo * 1000),
    grantId: "grant-1",
  };
}

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
