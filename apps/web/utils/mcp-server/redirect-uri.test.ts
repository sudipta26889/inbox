import { describe, expect, it } from "vitest";
import { SafeError } from "@/utils/error";
import { redirectUriMatches, validateRedirectUri } from "./redirect-uri";

describe("validateRedirectUri", () => {
  it("allows localhost on any port over http", () => {
    expect(() =>
      validateRedirectUri("http://localhost:33389/mcp-oauth-callback"),
    ).not.toThrow();
    expect(() =>
      validateRedirectUri("http://127.0.0.1:8080/callback"),
    ).not.toThrow();
  });

  it("allows https and claude: schemes", () => {
    expect(() =>
      validateRedirectUri("https://claude.ai/api/mcp/auth_callback"),
    ).not.toThrow();
    expect(() => validateRedirectUri("claude://oauth/callback")).not.toThrow();
  });

  it("allows the IPv6 loopback and the other known client schemes", () => {
    for (const uri of [
      "http://[::1]:1234/callback",
      "cursor://anysphere.cursor-retrieval/oauth/callback",
      "vscode://ms-vscode.mcp/callback",
      "vscode-insiders://ms-vscode.mcp/callback",
      "windsurf://codeium.windsurf/callback",
    ]) {
      expect(() => validateRedirectUri(uri)).not.toThrow();
    }
  });

  it("rejects plain http on non-localhost hosts", () => {
    expect(() => validateRedirectUri("http://evil.com/callback")).toThrow(
      SafeError,
    );
  });

  it("rejects malformed URIs", () => {
    expect(() => validateRedirectUri("not-a-url")).toThrow(SafeError);
  });
});

describe("redirectUriMatches", () => {
  const registered = ["http://127.0.0.1:3000/callback?x=1"];

  it("matches an exact URI", () => {
    expect(
      redirectUriMatches("https://claude.ai/api/mcp/auth_callback", [
        "https://claude.ai/api/mcp/auth_callback",
      ]),
    ).toBe(true);
  });

  it("lets a loopback URI change port", () => {
    expect(
      redirectUriMatches("http://127.0.0.1:54321/callback?x=1", registered),
    ).toBe(true);
  });

  it("lets a loopback URI match a registration without a port", () => {
    expect(
      redirectUriMatches("http://localhost:54321/cb", ["http://localhost/cb"]),
    ).toBe(true);
  });

  it("treats localhost, 127.0.0.1 and [::1] as the same loopback", () => {
    expect(
      redirectUriMatches("http://localhost:9999/callback?x=1", registered),
    ).toBe(true);
    expect(
      redirectUriMatches("http://[::1]:9999/callback?x=1", registered),
    ).toBe(true);
  });

  it("rejects a different path on loopback", () => {
    expect(
      redirectUriMatches("http://127.0.0.1:3000/other?x=1", registered),
    ).toBe(false);
  });

  it("rejects a different query on loopback", () => {
    expect(
      redirectUriMatches("http://127.0.0.1:3000/callback?x=2", registered),
    ).toBe(false);
  });

  it("rejects a different https host", () => {
    expect(
      redirectUriMatches("https://evil.example/cb", ["https://claude.ai/cb"]),
    ).toBe(false);
  });

  it("does not apply the loopback port rule to https", () => {
    expect(
      redirectUriMatches("https://localhost:9999/cb", ["https://localhost/cb"]),
    ).toBe(false);
  });

  it("rejects an unparseable URI", () => {
    expect(redirectUriMatches("nope", registered)).toBe(false);
  });
});
