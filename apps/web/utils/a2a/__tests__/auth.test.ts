import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  authenticateA2aRequest,
  hasRequiredScope,
  hasAnyScope,
  hasAllScopes,
  verifyEmailAccountOwnership,
  getUserEmailAccounts,
  validateSkillAccess,
  withA2aAuth,
} from "../auth";
import type { A2aAuthContext } from "../auth";

// Mock dependencies
vi.mock("@/utils/prisma", () => ({
  default: {
    mcpServerClient: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    emailAccount: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

vi.mock("@/utils/mcp-server/tokens", () => ({
  validateAccessToken: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: {
    AUTH_SECRET: "test-secret",
    NEXTAUTH_SECRET: "test-secret",
    NEXT_PUBLIC_BASE_URL: "https://test.example.com",
  },
}));

const prisma = await import("@/utils/prisma").then((m) => m.default);
const { validateAccessToken } = await import("@/utils/mcp-server/tokens");

const mockTokenPayload = {
  sub: "user-123",
  email: "test@example.com",
  email_account_id: "email-account-456",
  scope: "email:read email:write calendar:read",
  client_id: "client-789",
  exp: Math.floor(Date.now() / 1000) + 3600,
  iat: Math.floor(Date.now() / 1000),
  jti: "token-jti-123",
  token_type: "access" as const,
};

const mockAuthContext: A2aAuthContext = {
  userId: "user-123",
  emailAccountId: "email-account-456",
  clientId: "client-789",
  scopes: ["email:read", "email:write", "calendar:read"],
  tokenPayload: mockTokenPayload,
};

describe("A2A Authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("authenticateA2aRequest", () => {
    it("should validate Bearer token", async () => {
      (validateAccessToken as any).mockResolvedValue(mockTokenPayload);
      (prisma.mcpServerClient.findUnique as any).mockResolvedValue({
        id: "client-internal-123",
        clientId: "client-789",
        type: "A2A",
      });
      (prisma.mcpServerClient.update as any).mockResolvedValue({});

      const result = await authenticateA2aRequest("Bearer valid-token-123");

      expect(result).toBeTruthy();
      expect(result?.userId).toBe("user-123");
      expect(result?.clientId).toBe("client-789");
      expect(result?.scopes).toEqual([
        "email:read",
        "email:write",
        "calendar:read",
      ]);

      // Should update client lastUsedAt
      expect(prisma.mcpServerClient.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            lastUsedAt: expect.any(Date),
          }),
        }),
      );
    });

    it("should reject missing Authorization header", async () => {
      const result = await authenticateA2aRequest(null);

      expect(result).toBeNull();
      expect(validateAccessToken).not.toHaveBeenCalled();
    });

    it("should reject invalid token format", async () => {
      const result = await authenticateA2aRequest("Invalid format");

      expect(result).toBeNull();
      expect(validateAccessToken).not.toHaveBeenCalled();
    });

    it("should reject expired tokens", async () => {
      (validateAccessToken as any).mockResolvedValue(null);

      const result = await authenticateA2aRequest("Bearer expired-token");

      expect(result).toBeNull();
    });

    it("should reject if client not found", async () => {
      (validateAccessToken as any).mockResolvedValue(mockTokenPayload);
      (prisma.mcpServerClient.findUnique as any).mockResolvedValue(null);

      const result = await authenticateA2aRequest("Bearer valid-token");

      expect(result).toBeNull();
    });
  });

  describe("Scope Validation", () => {
    it("should validate required scope", () => {
      expect(hasRequiredScope(mockAuthContext, "email:read")).toBe(true);
      expect(hasRequiredScope(mockAuthContext, "email:write")).toBe(true);
      expect(hasRequiredScope(mockAuthContext, "calendar:write")).toBe(false);
    });

    it("should validate any scope", () => {
      expect(
        hasAnyScope(mockAuthContext, ["email:read", "calendar:write"]),
      ).toBe(true);
      expect(
        hasAnyScope(mockAuthContext, ["calendar:write", "stats:read"]),
      ).toBe(false);
    });

    it("should validate all scopes", () => {
      expect(hasAllScopes(mockAuthContext, ["email:read", "email:write"])).toBe(
        true,
      );
      expect(
        hasAllScopes(mockAuthContext, ["email:read", "calendar:write"]),
      ).toBe(false);
    });

    it("should reject insufficient scope", async () => {
      const limitedContext = {
        ...mockAuthContext,
        scopes: ["email:read"],
      };

      const result = await validateSkillAccess(
        limitedContext,
        "email.send",
        "email:write",
      );

      expect(result).toBeTruthy();
      expect(result?.status).toBe(403);
      expect(result?.body.error).toBe("insufficient_scope");
    });

    it("should allow access with correct scope", async () => {
      const result = await validateSkillAccess(
        mockAuthContext,
        "email.search",
        "email:read",
      );

      expect(result).toBeNull();
    });
  });

  describe("Email Account Ownership", () => {
    it("should verify user owns email account", async () => {
      (prisma.emailAccount.findFirst as any).mockResolvedValue({
        id: "email-account-456",
        userId: "user-123",
      });

      const result = await verifyEmailAccountOwnership(
        "user-123",
        "email-account-456",
      );

      expect(result).toBe(true);
    });

    it("should reject access to other users' accounts", async () => {
      (prisma.emailAccount.findFirst as any).mockResolvedValue(null);

      const result = await verifyEmailAccountOwnership(
        "user-123",
        "other-account-789",
      );

      expect(result).toBe(false);
    });
  });

  describe("getUserEmailAccounts", () => {
    it("should return all email accounts for user", async () => {
      (prisma.emailAccount.findMany as any).mockResolvedValue([
        { id: "account-1" },
        { id: "account-2" },
        { id: "account-3" },
      ]);

      const result = await getUserEmailAccounts("user-123");

      expect(result).toEqual(["account-1", "account-2", "account-3"]);
    });

    it("should return empty array if no accounts", async () => {
      (prisma.emailAccount.findMany as any).mockResolvedValue([]);

      const result = await getUserEmailAccounts("user-123");

      expect(result).toEqual([]);
    });
  });

  describe("Error Responses", () => {
    it("should create unauthorized response with correct headers", async () => {
      const { createUnauthorizedResponse } = await import("../auth");
      const response = createUnauthorizedResponse();

      expect(response.status).toBe(401);
      expect(response.headers["WWW-Authenticate"]).toContain("Bearer");
      expect(response.body.error).toBe("invalid_token");
    });

    it("should create forbidden response with required scope", async () => {
      const { createForbiddenResponse } = await import("../auth");
      const response = createForbiddenResponse("email:write");

      expect(response.status).toBe(403);
      expect(response.body.error).toBe("insufficient_scope");
      expect(response.body.required_scope).toBe("email:write");
    });
  });

  describe("withA2aAuth", () => {
    function request(headers: Record<string, string> = {}) {
      return new Request("https://test.example.com/a2a/stream", { headers });
    }

    beforeEach(() => {
      (validateAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue(
        mockTokenPayload,
      );
      (
        prisma.mcpServerClient.findUnique as ReturnType<typeof vi.fn>
      ).mockResolvedValue({ id: "c1", clientId: "client-789" });
    });

    it("returns the context when a required scope is held", async () => {
      const context = await withA2aAuth(
        request({ Authorization: "Bearer t" }),
        ["email:read"],
      );

      expect(context.userId).toBe("user-123");
    });

    // hasAnyScope([]) is false, so an empty list used to forbid everything.
    // It has to mean "any valid token will do" for auth-only endpoints.
    it("treats an empty scope list as authentication only", async () => {
      const context = await withA2aAuth(
        request({ Authorization: "Bearer t" }),
        [],
      );

      expect(context.clientId).toBe("client-789");
    });

    it("throws a Response rather than returning a flag", async () => {
      // Callers must catch; a truthy `authorized` field does not exist.
      await expect(
        withA2aAuth(request({ Authorization: "Bearer t" }), ["rules:write"]),
      ).rejects.toBeInstanceOf(Response);
    });

    it("throws a Response when unauthenticated", async () => {
      await expect(withA2aAuth(request(), [])).rejects.toBeInstanceOf(Response);
    });
  });
});
