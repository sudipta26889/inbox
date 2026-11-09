import { describe, expect, it, vi } from "vitest";
import type { EmailFilter, EmailProvider } from "@/utils/email/types";
import { GmailLabel } from "@/utils/gmail/label";
import { findAutoArchiveFilter } from "./helpers";

vi.mock("@/utils/prisma");

describe("findAutoArchiveFilter", () => {
  const gmail = { name: "google" } as EmailProvider;

  function archiveFilter(id: string, from: string): EmailFilter {
    return {
      id,
      criteria: { from },
      action: { removeLabelIds: [GmailLabel.INBOX] },
    };
  }

  function find(filters: EmailFilter[], sender: string) {
    return findAutoArchiveFilter(filters, sender, gmail)?.id;
  }

  it("does not match a sender whose address is part of another sender's", () => {
    const filters = [
      archiveFilter("newsletter", "newsletter@shop.com"),
      archiveFilter("acme-com", "hello@acme.com"),
    ];

    expect(find(filters, "letter@shop.com")).toBeUndefined();
    expect(find(filters, "hello@acme.co")).toBeUndefined();
  });

  it("matches the exact sender, ignoring case and display name", () => {
    const filters = [archiveFilter("one", "News@Shop.com")];

    expect(find(filters, "Shop <news@shop.com>")).toBe("one");
  });

  it.each([
    "first@example.com OR second@example.com",
    "first@example.com|second@example.com",
    "{first@example.com second@example.com}",
  ])("matches each sender listed in %s", (criterion) => {
    const filters = [archiveFilter("list", criterion)];

    expect(find(filters, "first@example.com")).toBe("list");
    expect(find(filters, "second@example.com")).toBe(
      criterion.includes("second") ? "list" : undefined,
    );
    expect(find(filters, "irst@example.com")).toBeUndefined();
  });

  it("ignores filters that do not archive", () => {
    const filters: EmailFilter[] = [
      {
        id: "label",
        criteria: { from: "a@shop.com" },
        action: { addLabelIds: ["Label_1"] },
      },
    ];

    expect(find(filters, "a@shop.com")).toBeUndefined();
  });
});
