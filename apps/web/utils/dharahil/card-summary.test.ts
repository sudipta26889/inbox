import { describe, expect, it } from "vitest";
import { approvalSummary, displayNameOf } from "./card-summary";

describe("approvalSummary", () => {
  it("names the person", () => {
    expect(
      approvalSummary({ what: "a reply", preposition: "to", name: "Jane Doe" }),
    ).toBe("Approve a reply to Jane Doe");
  });

  it("leaves the person out when there is no name", () => {
    expect(
      approvalSummary({ what: "a reply", preposition: "to", name: "" }),
    ).toBe("Approve a reply");
    expect(approvalSummary({ what: "a calendar event" })).toBe(
      "Approve a calendar event",
    );
  });
});

describe("displayNameOf", () => {
  it("returns the display name", () => {
    expect(displayNameOf("Jane Doe <jane@acme.com>")).toBe("Jane Doe");
    expect(displayNameOf('"Doe, Jane" <jane@acme.com>')).toBe("Doe, Jane");
  });

  it("never returns an address", () => {
    expect(displayNameOf("jane@acme.com")).toBe("");
    expect(displayNameOf("<jane@acme.com>")).toBe("");
    expect(displayNameOf("jane@acme.com <jane@acme.com>")).toBe("");
  });
});
