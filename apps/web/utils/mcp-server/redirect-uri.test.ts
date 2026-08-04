import { describe, expect, it } from "vitest";
import { SafeError } from "@/utils/error";
import { validateRedirectUri } from "./redirect-uri";

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

  it("rejects plain http on non-localhost hosts", () => {
    expect(() => validateRedirectUri("http://evil.com/callback")).toThrow(
      SafeError,
    );
  });

  it("rejects malformed URIs", () => {
    expect(() => validateRedirectUri("not-a-url")).toThrow(SafeError);
  });
});
