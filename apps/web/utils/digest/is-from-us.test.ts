import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOwnSendingAddress } from "./is-from-us";

// The real env is readonly; these tests need to vary the sending addresses.
const mockEnv = vi.hoisted(() => ({
  SMTP_FROM_EMAIL: undefined as string | undefined,
  RESEND_FROM_EMAIL: undefined as string | undefined,
}));

vi.mock("@/env", () => ({ env: mockEnv }));

describe("isOwnSendingAddress", () => {
  beforeEach(() => {
    mockEnv.SMTP_FROM_EMAIL = "Inbox <no-reply@inbox.sudiptadhara.in>";
    mockEnv.RESEND_FROM_EMAIL =
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
    mockEnv.SMTP_FROM_EMAIL = undefined;
    mockEnv.RESEND_FROM_EMAIL = undefined;
    expect(isOwnSendingAddress("sender@example.com")).toBe(false);
  });

  it("handles an empty from header", () => {
    expect(isOwnSendingAddress("")).toBe(false);
  });
});
