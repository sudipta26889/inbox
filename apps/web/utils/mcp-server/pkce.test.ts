import { describe, it, expect } from "vitest";
import {
  generateCodeVerifier,
  createCodeChallenge,
  verifyCodeChallenge,
  validateCodeVerifier,
  validateCodeChallengeMethod,
  generateSecureToken,
} from "./pkce";

describe("PKCE utilities", () => {
  describe("generateCodeVerifier", () => {
    it("should generate a code verifier", () => {
      const verifier = generateCodeVerifier();
      expect(verifier).toBeTruthy();
      expect(typeof verifier).toBe("string");
    });

    it("should generate verifiers of valid length (43-128 chars)", () => {
      const verifier = generateCodeVerifier();
      expect(verifier.length).toBeGreaterThanOrEqual(43);
      expect(verifier.length).toBeLessThanOrEqual(128);
    });

    it("should generate verifiers with only allowed characters", () => {
      const verifier = generateCodeVerifier();
      const allowedChars = /^[A-Za-z0-9\-._~]+$/;
      expect(verifier).toMatch(allowedChars);
    });

    it("should generate unique verifiers", () => {
      const verifier1 = generateCodeVerifier();
      const verifier2 = generateCodeVerifier();
      expect(verifier1).not.toBe(verifier2);
    });
  });

  describe("createCodeChallenge", () => {
    it("should create S256 challenge from verifier", () => {
      const verifier = "test-verifier-12345678901234567890123456789";
      const challenge = createCodeChallenge(verifier, "S256");
      expect(challenge).toBeTruthy();
      expect(typeof challenge).toBe("string");
      // S256 challenges are base64url encoded SHA-256 hashes (43 chars)
      expect(challenge.length).toBe(43);
    });

    it("should create plain challenge (same as verifier)", () => {
      const verifier = "test-verifier-12345678901234567890123456789";
      const challenge = createCodeChallenge(verifier, "plain");
      expect(challenge).toBe(verifier);
    });

    it("should default to S256 method", () => {
      const verifier = "test-verifier-12345678901234567890123456789";
      const challenge1 = createCodeChallenge(verifier);
      const challenge2 = createCodeChallenge(verifier, "S256");
      expect(challenge1).toBe(challenge2);
    });

    it("should throw error for unsupported method", () => {
      const verifier = "test-verifier";
      expect(() => createCodeChallenge(verifier, "invalid" as any)).toThrow();
    });

    it("should produce consistent challenges for same verifier", () => {
      const verifier = "test-verifier-12345678901234567890123456789";
      const challenge1 = createCodeChallenge(verifier, "S256");
      const challenge2 = createCodeChallenge(verifier, "S256");
      expect(challenge1).toBe(challenge2);
    });
  });

  describe("verifyCodeChallenge", () => {
    it("should verify valid S256 challenge", () => {
      const verifier = generateCodeVerifier();
      const challenge = createCodeChallenge(verifier, "S256");
      const isValid = verifyCodeChallenge(verifier, challenge, "S256");
      expect(isValid).toBe(true);
    });

    it("should verify valid plain challenge", () => {
      const verifier = "test-verifier-12345678901234567890123456789";
      const challenge = createCodeChallenge(verifier, "plain");
      const isValid = verifyCodeChallenge(verifier, challenge, "plain");
      expect(isValid).toBe(true);
    });

    it("should reject invalid verifier", () => {
      const verifier = generateCodeVerifier();
      const wrongVerifier = generateCodeVerifier();
      const challenge = createCodeChallenge(verifier, "S256");
      const isValid = verifyCodeChallenge(wrongVerifier, challenge, "S256");
      expect(isValid).toBe(false);
    });

    it("should reject tampered challenge", () => {
      const verifier = generateCodeVerifier();
      const challenge = createCodeChallenge(verifier, "S256");
      const tamperedChallenge = challenge.slice(0, -1) + "X";
      const isValid = verifyCodeChallenge(verifier, tamperedChallenge, "S256");
      expect(isValid).toBe(false);
    });

    it("should default to S256 method", () => {
      const verifier = generateCodeVerifier();
      const challenge = createCodeChallenge(verifier, "S256");
      const isValid = verifyCodeChallenge(verifier, challenge);
      expect(isValid).toBe(true);
    });
  });

  describe("validateCodeVerifier", () => {
    it("should accept valid verifiers", () => {
      const verifier = generateCodeVerifier();
      expect(validateCodeVerifier(verifier)).toBe(true);
    });

    it("should accept verifiers with all allowed characters", () => {
      const verifier = "ABC-._~123xyz" + "0".repeat(30);
      expect(validateCodeVerifier(verifier)).toBe(true);
    });

    it("should reject empty verifier", () => {
      expect(validateCodeVerifier("")).toBe(false);
    });

    it("should reject verifier that is too short", () => {
      const shortVerifier = "short";
      expect(validateCodeVerifier(shortVerifier)).toBe(false);
    });

    it("should reject verifier that is too long", () => {
      const longVerifier = "a".repeat(129);
      expect(validateCodeVerifier(longVerifier)).toBe(false);
    });

    it("should reject verifier with invalid characters", () => {
      const invalidVerifier = "test@verifier#123" + "0".repeat(30);
      expect(validateCodeVerifier(invalidVerifier)).toBe(false);
    });

    it("should accept verifier at minimum length (43)", () => {
      const minLengthVerifier = "a".repeat(43);
      expect(validateCodeVerifier(minLengthVerifier)).toBe(true);
    });

    it("should accept verifier at maximum length (128)", () => {
      const maxLengthVerifier = "a".repeat(128);
      expect(validateCodeVerifier(maxLengthVerifier)).toBe(true);
    });
  });

  describe("validateCodeChallengeMethod", () => {
    it("should accept S256 method", () => {
      expect(validateCodeChallengeMethod("S256")).toBe(true);
    });

    it("should accept plain method", () => {
      expect(validateCodeChallengeMethod("plain")).toBe(true);
    });

    it("should reject invalid methods", () => {
      expect(validateCodeChallengeMethod("invalid")).toBe(false);
      expect(validateCodeChallengeMethod("sha256")).toBe(false);
      expect(validateCodeChallengeMethod("")).toBe(false);
    });
  });

  describe("generateSecureToken", () => {
    it("should generate a secure token", () => {
      const token = generateSecureToken();
      expect(token).toBeTruthy();
      expect(typeof token).toBe("string");
    });

    it("should generate tokens with only URL-safe characters", () => {
      const token = generateSecureToken();
      const urlSafeChars = /^[A-Za-z0-9\-_]+$/;
      expect(token).toMatch(urlSafeChars);
    });

    it("should generate unique tokens", () => {
      const token1 = generateSecureToken();
      const token2 = generateSecureToken();
      expect(token1).not.toBe(token2);
    });

    it("should support custom byte length", () => {
      const token16 = generateSecureToken(16);
      const token64 = generateSecureToken(64);
      expect(token64.length).toBeGreaterThan(token16.length);
    });

    it("should default to 32 bytes", () => {
      const token = generateSecureToken();
      // 32 bytes in base64url is 43 characters (32 * 4/3, rounded up)
      expect(token.length).toBe(43);
    });
  });

  describe("RFC 7636 compliance", () => {
    it("should complete full PKCE flow", () => {
      // 1. Client generates verifier
      const verifier = generateCodeVerifier();
      expect(validateCodeVerifier(verifier)).toBe(true);

      // 2. Client creates challenge
      const challenge = createCodeChallenge(verifier, "S256");
      expect(challenge).toBeTruthy();

      // 3. Server verifies challenge matches verifier
      const isValid = verifyCodeChallenge(verifier, challenge, "S256");
      expect(isValid).toBe(true);
    });

    it("should detect PKCE attacks", () => {
      // Attacker intercepts authorization code and tries to exchange it
      const legitimateVerifier = generateCodeVerifier();
      const legitimateChallenge = createCodeChallenge(
        legitimateVerifier,
        "S256",
      );

      // Attacker generates their own verifier
      const attackerVerifier = generateCodeVerifier();

      // Server verifies: attacker's verifier doesn't match legitimate challenge
      const isValid = verifyCodeChallenge(
        attackerVerifier,
        legitimateChallenge,
        "S256",
      );
      expect(isValid).toBe(false);
    });
  });
});
