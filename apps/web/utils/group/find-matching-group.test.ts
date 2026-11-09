import { describe, expect, it } from "vitest";
import { findMatchingGroupItem } from "./find-matching-group";
import { GroupItemType } from "@/generated/prisma/enums";

// Run with:
// pnpm test utils/group/find-matching-group.test.ts

describe("findMatchingGroupItem", () => {
  it("should match FROM rules", () => {
    const groupItems = [
      {
        type: GroupItemType.FROM,
        value: "newsletter@company.com",
        exclude: false,
      },
      { type: GroupItemType.FROM, value: "@company.com", exclude: false },
    ];

    // Full email match
    expect(
      findMatchingGroupItem(
        { from: "newsletter@company.com", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[0]);

    // Partial domain match
    expect(
      findMatchingGroupItem(
        { from: "support@company.com", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[1]);

    // No match
    expect(
      findMatchingGroupItem(
        { from: "someone@other.com", subject: "" },
        groupItems,
      ),
    ).toBeUndefined();
  });

  it("matches a learned address only on the whole sender address", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "ann@acme.com", exclude: false },
    ];

    expectMatchResults(groupItems, [
      {
        email: { from: "Ann <Ann@Acme.com>", subject: "" },
        expected: groupItems[0],
      },
      // A longer local part or a domain suffix is a different sender.
      {
        email: { from: '"Jo" <joann@acme.com>', subject: "" },
        expected: undefined,
      },
      {
        email: { from: "ann@acme.com.evil.io", subject: "" },
        expected: undefined,
      },
    ]);
  });

  it("matches a learned domain without matching lookalike domains", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "@acme.com", exclude: false },
      { type: GroupItemType.FROM, value: "news.io", exclude: false },
    ];

    expectMatchResults(groupItems, [
      {
        email: { from: "Billing <billing@acme.com>", subject: "" },
        expected: groupItems[0],
      },
      {
        email: { from: "billing@acme.com.evil.io", subject: "" },
        expected: undefined,
      },
      {
        email: { from: "daily@news.io", subject: "" },
        expected: groupItems[1],
      },
      {
        email: { from: "daily@mail.news.io", subject: "" },
        expected: groupItems[1],
      },
      {
        email: { from: "daily@fakenews.io", subject: "" },
        expected: undefined,
      },
    ]);
  });

  it("still matches a learned display name anywhere in the From header", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "LinkedIn", exclude: false },
    ];

    expectMatchResults(groupItems, [
      {
        email: {
          from: "LinkedIn Jobs <jobs-noreply@linkedin.com>",
          subject: "",
        },
        expected: groupItems[0],
      },
    ]);
  });

  it("matches a learned pattern saved as a full From header by its address", () => {
    const groupItems = [
      {
        type: GroupItemType.FROM,
        value: "Ann Lee <ann@acme.com>",
        exclude: false,
      },
    ];

    expectMatchResults(groupItems, [
      { email: { from: "ann@acme.com", subject: "" }, expected: groupItems[0] },
      {
        email: { from: "joann@acme.com", subject: "" },
        expected: undefined,
      },
    ]);
  });

  it("matches each address in a learned value that lists several", () => {
    const groupItems = [
      {
        type: GroupItemType.FROM,
        value: "ann@acme.com, @news.io",
        exclude: false,
      },
    ];

    expectMatchResults(groupItems, [
      { email: { from: "ann@acme.com", subject: "" }, expected: groupItems[0] },
      {
        email: { from: "daily@news.io", subject: "" },
        expected: groupItems[0],
      },
      {
        email: { from: "joann@acme.com", subject: "" },
        expected: undefined,
      },
    ]);
  });

  it("does not split a learned full header on a comma in its display name", () => {
    const groupItems = [
      {
        type: GroupItemType.FROM,
        value: "Acme, Inc <ann@acme.com>",
        exclude: true,
      },
    ];

    expect(
      findMatchingGroupItem(
        { from: "Acme Team <other@example.com>", subject: "" },
        groupItems,
      ),
    ).toBeUndefined();
    expect(
      findMatchingGroupItem({ from: "ann@acme.com", subject: "" }, groupItems),
    ).toBeNull();
  });

  it("does not let an exclusion for one sender exclude a lookalike sender", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "@acme.com", exclude: false },
      { type: GroupItemType.FROM, value: "ann@acme.com", exclude: true },
    ];

    expect(
      findMatchingGroupItem(
        { from: "joann@acme.com", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[0]);
  });

  it("should match SUBJECT rules", () => {
    const groupItems = [
      { type: GroupItemType.SUBJECT, value: "Invoice", exclude: false },
      { type: GroupItemType.SUBJECT, value: "[GitHub]", exclude: false },
    ];

    // Exact subject match
    expect(
      findMatchingGroupItem({ from: "", subject: "Invoice #123" }, groupItems),
    ).toBe(groupItems[0]);

    // Match after number removal
    expect(
      findMatchingGroupItem(
        { from: "", subject: "Invoice INV-2023-001 from Company" },
        groupItems,
      ),
    ).toBe(groupItems[0]);

    // GitHub notification match
    expect(
      findMatchingGroupItem(
        { from: "", subject: "[GitHub] PR #456: Fix bug" },
        groupItems,
      ),
    ).toBe(groupItems[1]);

    // No match
    expect(
      findMatchingGroupItem(
        { from: "", subject: "Welcome to our service" },
        groupItems,
      ),
    ).toBeUndefined();
  });

  it("should handle empty inputs", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "test@example.com", exclude: false },
      { type: GroupItemType.SUBJECT, value: "Test", exclude: false },
    ];

    expect(
      findMatchingGroupItem({ from: "", subject: "" }, groupItems),
    ).toBeUndefined();

    expect(
      findMatchingGroupItem(
        { from: "test@example.com", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[0]);
  });

  it("should prioritize first matching rule", () => {
    const groupItems = [
      { type: GroupItemType.SUBJECT, value: "Invoice", exclude: false },
      { type: GroupItemType.SUBJECT, value: "Company", exclude: false },
    ];

    // Should return first matching rule even though both would match
    expect(
      findMatchingGroupItem(
        { from: "", subject: "Invoice from Company" },
        groupItems,
      ),
    ).toBe(groupItems[0]);
  });

  it("should match FROM rules case-insensitively", () => {
    const groupItems = [
      { type: GroupItemType.FROM, value: "@Acme-Corp.com", exclude: false },
    ];

    // Lowercase email should match mixed-case pattern
    expect(
      findMatchingGroupItem(
        { from: "billing@acme-corp.com", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[0]);

    // Uppercase email should match mixed-case pattern
    expect(
      findMatchingGroupItem(
        { from: "BILLING@ACME-CORP.COM", subject: "" },
        groupItems,
      ),
    ).toBe(groupItems[0]);
  });

  it("should match SUBJECT rules case-insensitively", () => {
    const groupItems = [
      { type: GroupItemType.SUBJECT, value: "Invoice", exclude: false },
    ];

    // Lowercase subject should match capitalized pattern
    expect(
      findMatchingGroupItem(
        { from: "", subject: "invoice #12345" },
        groupItems,
      ),
    ).toBe(groupItems[0]);

    // Uppercase subject should match capitalized pattern
    expect(
      findMatchingGroupItem(
        { from: "", subject: "INVOICE #12345" },
        groupItems,
      ),
    ).toBe(groupItems[0]);
  });
});

function expectMatchResults(
  groupItems: Array<{
    type: GroupItemType;
    value: string;
    exclude: boolean;
  }>,
  cases: Array<{
    email: { from: string; subject: string };
    expected?: (typeof groupItems)[number];
  }>,
) {
  for (const { email, expected } of cases) {
    expect(findMatchingGroupItem(email, groupItems)).toBe(expected);
  }
}
