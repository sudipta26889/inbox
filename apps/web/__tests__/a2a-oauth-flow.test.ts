import { describe, it, expect, beforeAll } from "vitest";
import { env } from "@/env";

/**
 * A2A OAuth Flow Integration Test
 *
 * Tests the complete OAuth 2.0 Authorization Code flow with PKCE
 * for A2A protocol authentication.
 *
 * Run with: pnpm test a2a-oauth-flow
 */

// Skip in CI if no test credentials
const skipTest =
  !process.env.A2A_TEST_CLIENT_ID || !process.env.A2A_TEST_CLIENT_SECRET;

describe.skipIf(skipTest)("A2A OAuth Flow", () => {
  let clientId: string;
  let clientSecret: string;
  let redirectUri: string;
  let authorizationCode: string;
  let accessToken: string;
  let refreshToken: string;

  beforeAll(() => {
    clientId = process.env.A2A_TEST_CLIENT_ID || "";
    clientSecret = process.env.A2A_TEST_CLIENT_SECRET || "";
    redirectUri = "http://localhost:3000/callback";
  });

  it("should discover agent via AgentCard", async () => {
    const response = await fetch(
      `${env.NEXT_PUBLIC_BASE_URL}/.well-known/agent-card.json`,
    );

    expect(response.ok).toBe(true);
    expect(response.headers.get("content-type")).toContain("application/json");

    const agentCard = await response.json();

    expect(agentCard.name).toBe("Inbox Email Automation Agent");
    expect(agentCard.version).toBe("1.0.0");
    expect(agentCard.capabilities.streaming).toBeDefined();
    expect(agentCard.capabilities.humanInTheLoop).toBe(true);
    expect(agentCard.skills).toBeInstanceOf(Array);
    expect(agentCard.skills.length).toBeGreaterThanOrEqual(10);
    expect(agentCard.security.type).toBe("oauth2");
    expect(agentCard.bindings).toBeInstanceOf(Array);
    expect(agentCard.bindings[0].url).toContain("/a2a");
  });

  it("should initiate OAuth authorization", async () => {
    // Generate PKCE challenge
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await generateCodeChallenge(codeVerifier);

    const authUrl = new URL(`${env.NEXT_PUBLIC_BASE_URL}/mcp-server/authorize`);
    authUrl.searchParams.set("client_id", clientId);
    authUrl.searchParams.set("redirect_uri", redirectUri);
    authUrl.searchParams.set("scope", "email:read email:write calendar:read");
    authUrl.searchParams.set("state", "test-state-123");
    authUrl.searchParams.set("code_challenge", codeChallenge);
    authUrl.searchParams.set("code_challenge_method", "S256");
    authUrl.searchParams.set("response_type", "code");

    const response = await fetch(authUrl.toString(), {
      redirect: "manual",
    });

    // Should redirect to login/authorization page
    expect(response.status).toBeGreaterThanOrEqual(300);
    expect(response.status).toBeLessThan(400);
    expect(response.headers.get("location")).toBeTruthy();
  });

  it("should exchange code for access token", async () => {
    // This test requires a valid authorization code
    // In a real test environment, you would obtain this through automation

    if (!process.env.A2A_TEST_AUTH_CODE) {
      console.log("Skipping: No authorization code provided");
      return;
    }

    const codeVerifier = process.env.A2A_TEST_CODE_VERIFIER || "";
    authorizationCode = process.env.A2A_TEST_AUTH_CODE;

    const response = await fetch(
      `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: authorizationCode,
          redirect_uri: redirectUri,
          client_id: clientId,
          client_secret: clientSecret,
          code_verifier: codeVerifier,
        }),
      },
    );

    expect(response.ok).toBe(true);

    const tokenResponse = await response.json();

    expect(tokenResponse.access_token).toBeTruthy();
    expect(tokenResponse.refresh_token).toBeTruthy();
    expect(tokenResponse.token_type).toBe("Bearer");
    expect(tokenResponse.expires_in).toBeGreaterThan(0);
    expect(tokenResponse.scope).toContain("email:read");

    accessToken = tokenResponse.access_token;
    refreshToken = tokenResponse.refresh_token;
  });

  it("should use access token to create tasks", async () => {
    if (!accessToken) {
      console.log("Skipping: No access token");
      return;
    }

    const response = await fetch(`${env.NEXT_PUBLIC_BASE_URL}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "message.send",
        params: {
          contextId: "test-context-oauth-flow",
          skill: "account.list",
          input: {},
        },
      }),
    });

    expect(response.ok).toBe(true);

    const result = await response.json();

    expect(result.jsonrpc).toBe("2.0");
    expect(result.id).toBe(1);
    expect(result.result.taskId).toBeTruthy();
    expect(result.result.contextId).toBe("test-context-oauth-flow");
  });

  it("should refresh expired tokens", async () => {
    if (!refreshToken) {
      console.log("Skipping: No refresh token");
      return;
    }

    const response = await fetch(
      `${env.NEXT_PUBLIC_BASE_URL}/mcp-server/token`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
      },
    );

    expect(response.ok).toBe(true);

    const tokenResponse = await response.json();

    expect(tokenResponse.access_token).toBeTruthy();
    expect(tokenResponse.refresh_token).toBeTruthy();
    expect(tokenResponse.token_type).toBe("Bearer");

    // New tokens should be different
    expect(tokenResponse.access_token).not.toBe(accessToken);
  });

  it("should reject requests with invalid tokens", async () => {
    const response = await fetch(`${env.NEXT_PUBLIC_BASE_URL}/a2a`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer invalid-token-123",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "task.list",
        params: { contextId: "test" },
      }),
    });

    const result = await response.json();

    expect(result.error).toBeDefined();
    expect(result.error.code).toBe(-32_002);
    expect(result.error.message).toContain("Authentication required");
  });
});

// Helper functions for PKCE
function generateCodeVerifier(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return base64UrlEncode(array);
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return base64UrlEncode(new Uint8Array(hash));
}

function base64UrlEncode(buffer: Uint8Array): string {
  return btoa(String.fromCharCode(...buffer))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}
