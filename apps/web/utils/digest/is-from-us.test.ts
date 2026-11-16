import { beforeEach, describe, expect, it, vi } from "vitest";
import { isOwnSendingAddress } from "./is-from-us";

// The real env is readonly; these tests need to vary the sending address.
const mockEnv = vi.hoisted(() => ({
  RESEND_FROM_EMAIL: undefined as string | undefined,
}));

vi.mock("@/env", () => ({ env: mockEnv }));

describe("isOwnSendingAddress", () => {
  beforeEach(() => {
    mockEnv.RESEND_FROM_EMAIL =
      "Inbox <updates@transactional.inbox.sudiptadhara.in>";
  });

  it("does not treat ordinary senders as our own address", () => {
    expect(isOwnSendingAddress("Some Sender <sender@example.com>")).toBe(false);
  });

  it("matches the from address regardless of display name", () => {
    expect(
      isOwnSendingAddress(
        "Anything <updates@transactional.inbox.sudiptadhara.in>",
      ),
    ).toBe(true);
    expect(
      isOwnSendingAddress("updates@transactional.inbox.sudiptadhara.in"),
    ).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(
      isOwnSendingAddress("UPDATES@transactional.inbox.sudiptadhara.in"),
    ).toBe(true);
  });

  it("handles an unset sending address", () => {
    mockEnv.RESEND_FROM_EMAIL = undefined;
    expect(isOwnSendingAddress("sender@example.com")).toBe(false);
  });

  it("handles an empty from header", () => {
    expect(isOwnSendingAddress("")).toBe(false);
  });
});
