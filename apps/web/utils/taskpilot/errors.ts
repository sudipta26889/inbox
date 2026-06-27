export class TaskpilotNotConfiguredError extends Error {
  readonly code = "TASKPILOT_NOT_CONFIGURED" as const;
  constructor(
    message = "TaskPilot credentials are not configured for this user",
  ) {
    super(message);
    this.name = "TaskpilotNotConfiguredError";
  }
}

export class TaskpilotAuthError extends Error {
  readonly code = "TASKPILOT_AUTH" as const;
  readonly status: 401 | 403;
  constructor(status: 401 | 403, message: string) {
    super(message);
    this.name = "TaskpilotAuthError";
    this.status = status;
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
  readonly status: 400 | 422;
  constructor(status: 400 | 422, message: string) {
    super(message);
    this.name = "TaskpilotValidationError";
    this.status = status;
  }
}

export class TaskpilotRateLimitError extends Error {
  readonly code = "TASKPILOT_RATE_LIMITED" as const;
  readonly resetAt: Date;
  constructor(resetAt: Date, message = "TaskPilot rate limit hit") {
    super(message);
    this.name = "TaskpilotRateLimitError";
    this.resetAt = resetAt;
  }
  retryAfterMs(now = Date.now()): number {
    return Math.max(0, this.resetAt.getTime() - now);
  }
}

export class TaskpilotServerError extends Error {
  readonly code = "TASKPILOT_SERVER" as const;
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TaskpilotServerError";
    this.status = status;
  }
}
