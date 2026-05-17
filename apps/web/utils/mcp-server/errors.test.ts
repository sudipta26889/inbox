import { describe, it, expect } from "vitest";
import {
  NotFoundError,
  ForbiddenError,
  ConflictError,
  StaleStateError,
  ValidationError,
  ProviderError,
  RateLimitedError,
} from "./errors";

describe("MCP admin domain errors", () => {
  it("NotFoundError carries code=NOT_FOUND and the supplied message", () => {
    const e = new NotFoundError("Rule r_1 not found");
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("NOT_FOUND");
    expect(e.message).toBe("Rule r_1 not found");
  });

  it("ForbiddenError carries code=FORBIDDEN", () => {
    const e = new ForbiddenError("nope");
    expect(e.code).toBe("FORBIDDEN");
  });

  it("ConflictError carries code=CONFLICT", () => {
    const e = new ConflictError("duplicate");
    expect(e.code).toBe("CONFLICT");
  });

  it("StaleStateError carries code=STALE_STATE", () => {
    const e = new StaleStateError("state changed");
    expect(e.code).toBe("STALE_STATE");
  });

  it("ValidationError carries code=VALIDATION_ERROR and optional details", () => {
    const e = new ValidationError("bad input", { field: "name" });
    expect(e.code).toBe("VALIDATION_ERROR");
    expect(e.details).toEqual({ field: "name" });
  });

  it("ProviderError carries code=PROVIDER_ERROR", () => {
    const e = new ProviderError("upstream 500");
    expect(e.code).toBe("PROVIDER_ERROR");
  });

  it("RateLimitedError carries code=RATE_LIMITED and optional retryAfterSec", () => {
    const e = new RateLimitedError("slow down", { retryAfterSec: 30 });
    expect(e.code).toBe("RATE_LIMITED");
    expect(e.details).toEqual({ retryAfterSec: 30 });
  });
});
