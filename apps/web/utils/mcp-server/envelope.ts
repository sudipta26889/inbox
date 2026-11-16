/**
 * Standard MCP admin-tool response envelope.
 *
 * Every admin_* tool returns McpResult<T>. Success may include either `data`
 * (when the tool committed) or `preview` (when dryRun is true). Failure carries
 * a code + message + optional details.
 */

export type McpSuccess<T> = {
  ok: true;
  dryRun?: boolean;
  data?: T;
  preview?: Record<string, unknown>;
};

export type McpFailure = {
  ok: false;
  error: {
    code: McpErrorCode;
    message: string;
    details?: Record<string, unknown>;
  };
};

export type McpResult<T> = McpSuccess<T> | McpFailure;

export type McpErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "FORBIDDEN"
  | "STALE_STATE"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "PROVIDER_ERROR"
  | "INTERNAL_ERROR";
