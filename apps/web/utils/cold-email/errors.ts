import { ConflictError, NotFoundError } from "@/utils/mcp-server/errors";

export class ColdEmailRuleNotFoundError extends NotFoundError {
  constructor(message = "Cold email rule not found") {
    super(message);
    this.name = "ColdEmailRuleNotFoundError";
  }
}

export class ColdEmailSenderNotFoundError extends NotFoundError {
  constructor(message = "Sender is not on the cold-email blocked list") {
    super(message);
    this.name = "ColdEmailSenderNotFoundError";
  }
}

export class ColdEmailConflictError extends ConflictError {
  constructor(message: string) {
    super(message);
    this.name = "ColdEmailConflictError";
  }
}
