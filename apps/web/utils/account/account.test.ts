import prisma from "@/utils/__mocks__/prisma";
import { NotFoundError } from "@/utils/mcp-server/errors";
import { describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import {
  getAccountProfile,
  updateAccountProfile,
  updateAccountProfileSchema,
} from "./account";

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

describe("updateAccountProfileSchema", () => {
  it("accepts a partial update with allowed fields", () => {
    const parsed = updateAccountProfileSchema.parse({
      about: "I run Acme.",
      timezone: "Asia/Jerusalem",
    });
    expect(parsed.about).toBe("I run Acme.");
    expect(parsed.timezone).toBe("Asia/Jerusalem");
  });

  it("trims and nullifies empty strings for nullable text fields", () => {
    const parsed = updateAccountProfileSchema.parse({
      about: "   ",
      signature: "",
    });
    expect(parsed.about).toBeNull();
    expect(parsed.signature).toBeNull();
  });

  it("rejects an unknown timezone", () => {
    expect(() =>
      updateAccountProfileSchema.parse({ timezone: "Mars/Olympus_Mons" }),
    ).toThrow(ZodError);
  });

  it("rejects a non-http calendarBookingLink", () => {
    expect(() =>
      updateAccountProfileSchema.parse({
        calendarBookingLink: "javascript:1",
      }),
    ).toThrow(ZodError);
  });

  it("accepts an https calendarBookingLink", () => {
    const parsed = updateAccountProfileSchema.parse({
      calendarBookingLink: "https://cal.example.com/alex",
    });
    expect(parsed.calendarBookingLink).toBe("https://cal.example.com/alex");
  });

  it("rejects unknown keys (strict)", () => {
    expect(() =>
      updateAccountProfileSchema.parse({ apiKey: "secret" }),
    ).toThrow(ZodError);
  });

  it("rejects an empty object (at least one field required)", () => {
    expect(() => updateAccountProfileSchema.parse({})).toThrow(ZodError);
  });

  it("caps name at 200 chars", () => {
    expect(() =>
      updateAccountProfileSchema.parse({ name: "a".repeat(201) }),
    ).toThrow(ZodError);
  });

  it("caps about at 2000 chars", () => {
    expect(() =>
      updateAccountProfileSchema.parse({ about: "a".repeat(2001) }),
    ).toThrow(ZodError);
  });

  it("caps signature at 20000 chars", () => {
    expect(() =>
      updateAccountProfileSchema.parse({ signature: "a".repeat(20_001) }),
    ).toThrow(ZodError);
  });
});

describe("updateAccountProfile", () => {
  const updatedRow = {
    id: "ea_1",
    email: "alex@example.com",
    createdAt: new Date(),
    updatedAt: new Date(),
    image: null,
    name: "Initial",
    about: "I run Acme.",
    signature: null,
    timezone: "Asia/Jerusalem",
    calendarBookingLink: null,
    role: null,
  };

  it("performs a partial update and returns the new profile", async () => {
    // First findFirst = ownership check (before update). Second findFirst =
    // re-read inside getAccountProfile() at the end of updateAccountProfile;
    // its select includes the nested `user` for taskpilot fields.
    prisma.emailAccount.findFirst
      .mockResolvedValueOnce({ id: "ea_1" } as never)
      .mockResolvedValueOnce({
        ...updatedRow,
        user: { taskpilotApiKey: null, taskpilotWorkspaceSlug: null },
      } as never);
    prisma.emailAccount.update.mockResolvedValue(updatedRow as never);

    const out = await updateAccountProfile(
      { userId: "user_1", emailAccountId: "ea_1" },
      { about: "I run Acme.", timezone: "Asia/Jerusalem" },
    );

    expect(out.about).toBe("I run Acme.");
    expect(out.timezone).toBe("Asia/Jerusalem");
    expect(out.name).toBe("Initial");

    const call = prisma.emailAccount.update.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "ea_1" });
    expect(call.data).toEqual({
      about: "I run Acme.",
      timezone: "Asia/Jerusalem",
    });
    // Defense in depth: data payload never contains excluded keys.
    expect(call.data).not.toHaveProperty("apiKey");
    expect(call.data).not.toHaveProperty("aiModel");
    expect(call.data).not.toHaveProperty("aiProvider");
    expect(call.data).not.toHaveProperty("coldEmailPrompt");
    expect(call.data).not.toHaveProperty("writingStyle");
  });

  describe("the TaskPilot project pin", () => {
    const PIN = "683db6a7-472b-4aa6-b7f1-c527f18579ee";
    const ctx = { userId: "user_1", emailAccountId: "ea_1" };

    const mockReads = () =>
      prisma.emailAccount.findFirst
        .mockResolvedValueOnce({ id: "ea_1" } as never)
        .mockResolvedValueOnce({
          ...updatedRow,
          user: {
            taskpilotApiKey: null,
            taskpilotWorkspaceSlug: null,
            taskpilotProjectId: PIN,
          },
        } as never);

    it("accepts a uuid or null, and rejects anything else", () => {
      expect(
        updateAccountProfileSchema.safeParse({ taskpilotProjectId: PIN })
          .success,
      ).toBe(true);
      expect(
        updateAccountProfileSchema.safeParse({ taskpilotProjectId: null })
          .success,
      ).toBe(true);
      expect(
        updateAccountProfileSchema.safeParse({ taskpilotProjectId: "junk" })
          .success,
      ).toBe(false);
    });

    it("lower-cases an upper-case project id", () => {
      const parsed = updateAccountProfileSchema.parse({
        taskpilotProjectId: PIN.toUpperCase(),
      });

      expect(parsed.taskpilotProjectId).toBe(PIN);
    });

    it("can be set without the key and slug, and leaves them alone", async () => {
      mockReads();
      prisma.user.update.mockResolvedValue({} as never);

      const out = await updateAccountProfile(ctx, { taskpilotProjectId: PIN });

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user_1" },
        data: { taskpilotProjectId: PIN },
      });
      expect(prisma.emailAccount.update).not.toHaveBeenCalled();
      expect(out.taskpilot.projectId).toBe(PIN);
    });

    it("can be cleared with null", async () => {
      mockReads();
      prisma.user.update.mockResolvedValue({} as never);

      await updateAccountProfile(ctx, { taskpilotProjectId: null });

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user_1" },
        data: { taskpilotProjectId: null },
      });
    });

    it("is saved together with the key and slug in one update", async () => {
      mockReads();
      prisma.user.update.mockResolvedValue({} as never);

      await updateAccountProfile(ctx, {
        taskpilotApiKey: "tk",
        taskpilotWorkspaceSlug: "acme",
        taskpilotProjectId: PIN,
      });

      expect(prisma.user.update).toHaveBeenCalledTimes(1);
      const data = (prisma.user.update.mock.calls[0][0] as { data: object })
        .data;
      expect(data).toMatchObject({
        taskpilotWorkspaceSlug: "acme",
        taskpilotProjectId: PIN,
      });
    });

    it("does not loosen the key and slug coupling", () => {
      expect(
        updateAccountProfileSchema.safeParse({
          taskpilotApiKey: "tk",
          taskpilotProjectId: PIN,
        }).success,
      ).toBe(false);
    });
  });

  it("throws NotFoundError when emailAccountId is wrong", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      updateAccountProfile(
        { userId: "user_1", emailAccountId: "missing" },
        { about: "x" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when account exists but is owned by another user", async () => {
    // findFirst is scoped by userId, so cross-user lookups return null.
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    await expect(
      updateAccountProfile(
        { userId: "user_1", emailAccountId: "ea_other" },
        { about: "x" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });
});
