export class CalendarWriteUnsupportedError extends Error {
  constructor(provider: string, operation: string) {
    super(
      `Calendar ${operation} is not supported for ${provider} yet. Only Google calendars can be modified.`,
    );
    this.name = "CalendarWriteUnsupportedError";
  }
}

export class CalendarNotConnectedError extends Error {
  constructor(email: string, connectedEmails: string[]) {
    super(
      connectedEmails.length
        ? `No calendar connected for '${email}'. Accounts with a calendar: ${connectedEmails.join(", ")}`
        : `No calendar connected for '${email}', and no other account has one. Connect a calendar first.`,
    );
    this.name = "CalendarNotConnectedError";
  }
}
