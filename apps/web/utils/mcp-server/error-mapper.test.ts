import { describe, it, expect } from "vitest";
import { mapDomainError } from "./error-mapper";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  StaleStateError,
  ValidationError,
  ProviderError,
  RateLimitedError,
} from "./errors";

describe("mapDomainError", () => {
  it("maps NotFoundError to NOT_FOUND envelope", () => {
    const out = mapDomainError(new NotFoundError("missing"));
    expect(out).toEqual({
      ok: false,
      error: { code: "NOT_FOUND", message: "missing" },
    });
  });

  it("maps ForbiddenError to NOT_FOUND for existence non-disclosure", () => {
    const out = mapDomainError(new ForbiddenError("not yours"));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.error.code).toBe("NOT_FOUND");
    }
  });

  it("maps ConflictError to CONFLICT", () => {
    const out = mapDomainError(new ConflictError("dup"));
    expect(out).toEqual({
      ok: false,
      error: { code: "CONFLICT", message: "dup" },
    });
  });

  it("maps StaleStateError to STALE_STATE", () => {
    const out = mapDomainError(new StaleStateError("moved"));
    expect(out).toEqual({
      ok: false,
      error: { code: "STALE_STATE", message: "moved" },
    });
  });

  it("maps ValidationError including details", () => {
    const out = mapDomainError(new ValidationError("bad", { field: "name" }));
    expect(out).toEqual({
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: "bad",
        details: { field: "name" },
      },
    });
  });

  it("maps ProviderError to PROVIDER_ERROR", () => {
    const out = mapDomainError(new ProviderError("upstream 500"));
    expect(out).toEqual({
      ok: false,
      error: { code: "PROVIDER_ERROR", message: "upstream 500" },
    });
  });

  it("maps RateLimitedError including details", () => {
    const out = mapDomainError(
      new RateLimitedError("slow", { retryAfterSec: 30 }),
    );
    expect(out).toEqual({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "slow",
        details: { retryAfterSec: 30 },
      },
    });
  });

  it("maps unknown errors to INTERNAL_ERROR with a generic message", () => {
    const out = mapDomainError(new Error("kaboom secret stack"));
    expect(out).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
    });
  });

  it("maps non-Error throws to INTERNAL_ERROR", () => {
    const out = mapDomainError("just a string");
    expect(out).toEqual({
      ok: false,
      error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
    });
  });
});
