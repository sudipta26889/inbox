import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOwnSendingAddress } from "./is-from-us";
import { env } from "@/env";

vi.mock("@/env", () => ({
  env: {
    SMTP_FROM_EMAIL: "Inbox <no-reply@inbox.sudiptadhara.in>",
    RESEND_FROM_EMAIL: "Inbox <updates@transactional.inbox.sudiptadhara.in>",
  },
}));

describe("isOwnSendingAddress", () => {
  beforeEach(() => {
    env.SMTP_FROM_EMAIL = "Inbox <no-reply@inbox.sudiptadhara.in>";
    env.RESEND_FROM_EMAIL =
      "Inbox <updates@transactional.inbox.sudiptadhara.in>";
  });

  it("does not treat ordinary senders as our own address", () => {
    expect(isOwnSendingAddress("Some Sender <sender@example.com>")).toBe(false);
  });

  it("matches the SMTP from address regardless of display name", () => {
    expect(
      isOwnSendingAddress("Anything <no-reply@inbox.sudiptadhara.in>"),
    ).toBe(true);
    expect(isOwnSendingAddress("no-reply@inbox.sudiptadhara.in")).toBe(true);
  });

  it("matches the Resend from address", () => {
    expect(
      isOwnSendingAddress("updates@transactional.inbox.sudiptadhara.in"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isOwnSendingAddress("NO-REPLY@inbox.sudiptadhara.in")).toBe(true);
  });

  it("handles unset sending addresses", () => {
    env.SMTP_FROM_EMAIL = undefined;
    env.RESEND_FROM_EMAIL = undefined;
    expect(isOwnSendingAddress("sender@example.com")).toBe(false);
  });

  it("handles an empty from header", () => {
    expect(isOwnSendingAddress("")).toBe(false);
  });
});
