import { createScopedLogger } from "@/utils/logger";
import type { McpFailure } from "./envelope";
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ProviderError,
  RateLimitedError,
  StaleStateError,
  ValidationError,
} from "./errors";

const logger = createScopedLogger("mcp-error-mapper");

/**
 * Translate a thrown domain error into the MCP failure envelope.
 *
 * ForbiddenError is mapped to NOT_FOUND in the response (existence
 * non-disclosure, per spec §7). Internal logs still record the true
 * FORBIDDEN classification so operators can debug.
 *
 * Unknown errors map to INTERNAL_ERROR with a generic user-safe message;
 * the original error (with stack) is logged for operators.
 */
export function mapDomainError(e: unknown): McpFailure {
  if (e instanceof NotFoundError) {
    return { ok: false, error: { code: "NOT_FOUND", message: e.message } };
  }

  if (e instanceof ForbiddenError) {
    logger.warn("ForbiddenError surfaced as NOT_FOUND", { message: e.message });
    return { ok: false, error: { code: "NOT_FOUND", message: e.message } };
  }

  if (e instanceof ConflictError) {
    return { ok: false, error: { code: "CONFLICT", message: e.message } };
  }

  if (e instanceof StaleStateError) {
    return { ok: false, error: { code: "STALE_STATE", message: e.message } };
  }

  if (e instanceof ValidationError) {
    return {
      ok: false,
      error: {
        code: "VALIDATION_ERROR",
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      },
    };
  }

  if (e instanceof RateLimitedError) {
    return {
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: e.message,
        ...(e.details ? { details: e.details } : {}),
      },
    };
  }

  if (e instanceof ProviderError) {
    return { ok: false, error: { code: "PROVIDER_ERROR", message: e.message } };
  }

  logger.error("Unhandled error in MCP admin tool", { error: e });
  return {
    ok: false,
    error: { code: "INTERNAL_ERROR", message: "An internal error occurred." },
  };
}
