// apps/web/utils/taskpilot/errors.ts

export class TaskpilotNotConfiguredError extends Error {
  readonly code = "TASKPILOT_NOT_CONFIGURED" as const;
  constructor(message = "TaskPilot credentials are not configured for this user") {
    super(message);
    this.name = "TaskpilotNotConfiguredError";
  }
}

export class TaskpilotAuthError extends Error {
  readonly code = "TASKPILOT_AUTH" as const;
  constructor(public readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "TaskpilotAuthError";
  }
}

export class TaskpilotNotFoundError extends Error {
  readonly code = "TASKPILOT_NOT_FOUND" as const;
  constructor(message: string) {
    super(message);
    this.name = "TaskpilotNotFoundError";
  }
}

export class TaskpilotValidationError extends Error {
  readonly code = "TASKPILOT_VALIDATION" as const;
  constructor(public readonly status: 400 | 422, message: string) {
    super(message);
    this.name = "TaskpilotValidationError";
  }
}

export class TaskpilotRateLimitError extends Error {
  readonly code = "TASKPILOT_RATE_LIMITED" as const;
  constructor(public readonly resetAt: Date, message = "TaskPilot rate limit hit") {
    super(message);
    this.name = "TaskpilotRateLimitError";
  }
  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.resetAt.getTime() - now);
  }
}

export class TaskpilotServerError extends Error {
  readonly code = "TASKPILOT_SERVER" as const;
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "TaskpilotServerError";
  }
}
