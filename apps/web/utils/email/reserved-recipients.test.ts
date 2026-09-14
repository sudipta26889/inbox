import { describe, expect, it } from "vitest";
import { assertDeliverableRecipient, isReservedRecipient } from "@inbox/resend";

// Source lives in packages/resend (the send chokepoint); the test lives here
// because the root `test` script only runs apps/web.
describe("isReservedRecipient", () => {
  it("rejects fixture and documentation domains", () => {
    expect(isReservedRecipient("user@test.com")).toBe(true);
    expect(isReservedRecipient("User@TEST.COM")).toBe(true);
    expect(isReservedRecipient("a@example.com")).toBe(true);
    expect(isReservedRecipient("a@example.org")).toBe(true);
    expect(isReservedRecipient("a@foo.test")).toBe(true);
    expect(isReservedRecipient("a@localhost")).toBe(true);
    expect(isReservedRecipient("a@thing.invalid")).toBe(true);
  });

  it("rejects unparseable addresses", () => {
    expect(isReservedRecipient("")).toBe(true);
    expect(isReservedRecipient("no-at-sign")).toBe(true);
    expect(isReservedRecipient("trailing@")).toBe(true);
  });

  it("allows ordinary recipient domains", () => {
    expect(isReservedRecipient("sudipta@sudiptadhara.in")).toBe(false);
    expect(isReservedRecipient("ops@grihatek.com")).toBe(false);
    expect(isReservedRecipient("a@example.com.co")).toBe(false);
  });
});

describe("assertDeliverableRecipient", () => {
  it("throws for user@test.com", () => {
    expect(() => assertDeliverableRecipient("user@test.com")).toThrow(
      /reserved\/test address/i,
    );
  });

  it("allows a real domain", () => {
    expect(() => assertDeliverableRecipient("ops@grihatek.com")).not.toThrow();
  });
});
