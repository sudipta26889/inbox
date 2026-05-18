import prisma from "@/utils/__mocks__/prisma";
import { NotFoundError } from "@/utils/mcp-server/errors";
import { describe, expect, it, vi } from "vitest";
import { getAccountProfile } from "./account";

vi.mock("@/utils/prisma");

describe("getAccountProfile", () => {
  it("returns the profile snapshot for the owning user", async () => {
    const now = new Date("2026-05-01T00:00:00Z");
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "ea_1",
      email: "alex@example.com",
      createdAt: now,
      updatedAt: now,
      image: null,
      name: "Alex Smith",
      about: "Founder of Acme.",
      signature: "<p>--<br/>Alex</p>",
      timezone: "America/Los_Angeles",
      calendarBookingLink: "https://cal.example.com/alex",
      role: "founder",
    } as never);

    const profile = await getAccountProfile({
      userId: "user_1",
      emailAccountId: "ea_1",
    });

    expect(profile).toMatchObject({
      id: "ea_1",
      email: "alex@example.com",
      name: "Alex Smith",
      about: "Founder of Acme.",
      signature: "<p>--<br/>Alex</p>",
      timezone: "America/Los_Angeles",
      calendarBookingLink: "https://cal.example.com/alex",
      role: "founder",
    });
    expect(profile.createdAt).toBeInstanceOf(Date);
  });

  it("scopes the lookup to userId + emailAccountId", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "ea_1",
      email: "x@example.com",
      createdAt: new Date(),
      updatedAt: new Date(),
      image: null,
      name: null,
      about: null,
      signature: null,
      timezone: null,
      calendarBookingLink: null,
      role: null,
    } as never);

    await getAccountProfile({ userId: "user_1", emailAccountId: "ea_1" });

    const call = prisma.emailAccount.findFirst.mock.calls[0]?.[0] as {
      where?: Record<string, unknown>;
      select?: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "ea_1", userId: "user_1" });
    expect(call.select).toMatchObject({
      id: true,
      email: true,
      name: true,
      about: true,
      signature: true,
      timezone: true,
      calendarBookingLink: true,
      role: true,
    });
    // Defense in depth: select must not request excluded credential fields.
    expect(call.select).not.toHaveProperty("apiKey");
    expect(call.select).not.toHaveProperty("aiApiKey");
    expect(call.select).not.toHaveProperty("aiProvider");
    expect(call.select).not.toHaveProperty("aiModel");
    expect(call.select).not.toHaveProperty("coldEmailPrompt");
    expect(call.select).not.toHaveProperty("writingStyle");
    expect(call.select).not.toHaveProperty("behaviorProfile");
    expect(call.select).not.toHaveProperty("personaAnalysis");
  });

  it("throws NotFoundError when the emailAccountId does not exist", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      getAccountProfile({
        userId: "user_1",
        emailAccountId: "does-not-exist",
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("throws NotFoundError when the account exists but is owned by another user", async () => {
    // findFirst is scoped by userId in the where clause, so it returns null
    // when the account belongs to a different user. This is the same
    // existence-non-disclosure path as a fully-missing row (per spec §7).
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      getAccountProfile({ userId: "user_1", emailAccountId: "ea_other" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
