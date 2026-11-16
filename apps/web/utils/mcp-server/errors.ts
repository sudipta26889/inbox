import type { McpErrorCode } from "./envelope";

abstract class McpDomainError extends Error {
  abstract readonly code: McpErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    this.details = details;
  }
}

export class NotFoundError extends McpDomainError {
  readonly code = "NOT_FOUND" as const;
}

export class ForbiddenError extends McpDomainError {
  readonly code = "FORBIDDEN" as const;
}

export class ConflictError extends McpDomainError {
  readonly code = "CONFLICT" as const;
}

export class StaleStateError extends McpDomainError {
  readonly code = "STALE_STATE" as const;
}

export class ValidationError extends McpDomainError {
  readonly code = "VALIDATION_ERROR" as const;
}

export class ProviderError extends McpDomainError {
  readonly code = "PROVIDER_ERROR" as const;
}

export class RateLimitedError extends McpDomainError {
  readonly code = "RATE_LIMITED" as const;
}
