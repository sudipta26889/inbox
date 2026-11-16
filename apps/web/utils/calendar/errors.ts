// Despite the name, this also covers unsupported reads (e.g. Outlook's
// listing/instance-listing) reached through calendar:read tools — keep the
// message provider-agnostic about read vs. write.
export class CalendarWriteUnsupportedError extends Error {
  constructor(provider: string, operation: string) {
    super(
      `Calendar ${operation} is not supported for ${provider} yet. Only Google calendars support this operation.`,
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
