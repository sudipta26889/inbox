import { auth } from "@googleapis/gmail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { saveTokens } from "@/utils/auth/save-tokens";
import { createTestLogger } from "@/__tests__/helpers";

// Real google-auth-library; only its HTTP transport (gaxios) is stubbed. The library
// overwrites the refresh_token in refreshAccessToken()'s result with the old
// one, so this fails if the client reads the rotated token from there.
vi.mock("server-only", () => ({}));
vi.mock("@/utils/auth/save-tokens", () => ({
  saveTokens: vi.fn().mockResolvedValue({ status: "saved" }),
}));
vi.mock("@/utils/auth/cleanup-invalid-tokens", () => ({
  cleanupInvalidTokens: vi.fn(),
}));

const logger = createTestLogger();

describe("getGmailClientWithRefresh with the real OAuth2 client", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.restoreAllMocks());

  // The same gaxios class the OAuth2 client sends its token request through.
  function stubTokenEndpoint(body: Record<string, unknown>) {
    const transporter = new auth.OAuth2().transporter;
    return vi
      .spyOn(Object.getPrototypeOf(transporter), "request")
      .mockImplementation(async (opts: unknown) => {
        const { url } = opts as { url: string };
        if (!url.includes("token"))
          throw new Error(`unexpected HTTP call ${url}`);
        return { data: { ...body }, status: 200 } as never;
      });
  }

  it("saves the refresh token Google rotated in the refresh response", async () => {
    const fetchMock = stubTokenEndpoint({
      access_token: "new-access",
      refresh_token: "rotated-refresh",
      expires_in: 3600,
    });

    await getGmailClientWithRefresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: null,
      emailAccountId: "ea-1",
      logger,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        accountRefreshToken: "old-refresh",
        tokens: expect.objectContaining({
          access_token: "new-access",
          refresh_token: "rotated-refresh",
        }),
      }),
    );
  });

  it("keeps the stored refresh token when Google does not rotate it", async () => {
    stubTokenEndpoint({ access_token: "new-access", expires_in: 3600 });

    await getGmailClientWithRefresh({
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: null,
      emailAccountId: "ea-1",
      logger,
    });

    expect(saveTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: expect.objectContaining({ refresh_token: undefined }),
      }),
    );
  });
});
