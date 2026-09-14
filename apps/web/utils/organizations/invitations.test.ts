import { describe, expect, it } from "vitest";
import {
  assertDeliverableInvitationEmail,
  isReservedInvitationRecipient,
} from "@/utils/organizations/invitations";

describe("isReservedInvitationRecipient", () => {
  it("rejects fixture and documentation domains", () => {
    expect(isReservedInvitationRecipient("user@test.com")).toBe(true);
    expect(isReservedInvitationRecipient("User@TEST.COM")).toBe(true);
    expect(isReservedInvitationRecipient("a@example.com")).toBe(true);
    expect(isReservedInvitationRecipient("a@example.org")).toBe(true);
    expect(isReservedInvitationRecipient("a@foo.test")).toBe(true);
    expect(isReservedInvitationRecipient("a@localhost")).toBe(true);
  });

  it("allows ordinary recipient domains", () => {
    expect(isReservedInvitationRecipient("sudipta@sudiptadhara.in")).toBe(
      false,
    );
    expect(isReservedInvitationRecipient("ops@grihatek.com")).toBe(false);
  });
});

describe("assertDeliverableInvitationEmail", () => {
  it("throws for user@test.com", () => {
    expect(() => assertDeliverableInvitationEmail("user@test.com")).toThrow(
      /reserved\/test address/i,
    );
  });

  it("allows a real domain", () => {
    expect(() =>
      assertDeliverableInvitationEmail("ops@grihatek.com"),
    ).not.toThrow();
  });
});
