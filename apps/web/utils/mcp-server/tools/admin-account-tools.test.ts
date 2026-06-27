import prisma from "@/utils/__mocks__/prisma";
import { describe, expect, it, vi } from "vitest";
import { adminAccountGet, adminAccountUpdate } from "./admin-account-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");

function ctx(
  userId: string,
  emailAccountId: string,
  scopes: string[] = ["admin"],
): McpToolContext {
  return {
    clientId: "test-client",
    emailAccountId,
    userId,
    scopes,
  };
}

const baseRow = {
  id: "ea_1",
  email: "alex@example.com",
  createdAt: new Date("2026-05-01T00:00:00Z"),
  updatedAt: new Date("2026-05-01T00:00:00Z"),
  image: null as string | null,
  name: "Alex",
  about: "About text",
  signature: "<p>Sig</p>",
  timezone: "Europe/London",
  calendarBookingLink: null as string | null,
  role: null as string | null,
  user: {
    taskpilotApiKey: null as string | null,
    taskpilotWorkspaceSlug: null as string | null,
  },
};

describe("admin_account_get", () => {
  it("returns the profile envelope", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(baseRow as never);

    const out = await adminAccountGet(ctx("user_1", "ea_1"), {});

    expect(out).toMatchObject({
      ok: true,
      data: { id: "ea_1", name: "Alex", about: "About text" },
    });
  });

  it("rejects unknown input keys", async () => {
    const out = await adminAccountGet(ctx("user_1", "ea_1"), { foo: 1 });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when the account is not owned by the user", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    const out = await adminAccountGet(ctx("user_1", "ea_other"), {});
    expect(out).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
  });

  it("never includes excluded fields in the response payload", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(baseRow as never);

    const out = await adminAccountGet(ctx("user_1", "ea_1"), {});
    const json = JSON.stringify(out);
    expect(json).not.toContain("apiKey");
    expect(json).not.toContain("aiApiKey");
    expect(json).not.toContain("aiProvider");
    expect(json).not.toContain("aiModel");
    expect(json).not.toContain("webhookUrl");
    expect(json).not.toContain("mcpClient");
  });

  it("returns taskpilot.configured=false when both fields are null", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(baseRow as never);
    const out = await adminAccountGet(ctx("user_1", "ea_1"), {});
    expect(out).toMatchObject({
      ok: true,
      data: { taskpilot: { configured: false, workspaceSlug: null } },
    });
  });

  it("returns taskpilot.configured=true when both fields are set", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({
      ...baseRow,
      user: {
        taskpilotApiKey: "enc:cipher",
        taskpilotWorkspaceSlug: "acme",
      },
    } as never);
    const out = await adminAccountGet(ctx("user_1", "ea_1"), {});
    expect(out).toMatchObject({
      ok: true,
      data: { taskpilot: { configured: true, workspaceSlug: "acme" } },
    });
    // The raw key is never returned
    const json = JSON.stringify(out);
    expect(json).not.toContain("enc:cipher");
    expect(json).not.toContain("taskpilotApiKey");
  });
});

describe("admin_account_update", () => {
  const updatedRow = {
    ...baseRow,
    name: "New",
    about: "Bio",
  };

  it("updates allowed fields and returns the new snapshot", async () => {
    prisma.emailAccount.findFirst
      .mockResolvedValueOnce({ id: "ea_1" } as never) // ownership check
      .mockResolvedValueOnce(updatedRow as never); // re-read at end
    prisma.emailAccount.update.mockResolvedValue(updatedRow as never);

    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      name: "New",
      about: "Bio",
    });

    expect(out).toMatchObject({
      ok: true,
      data: { name: "New", about: "Bio" },
    });

    const call = prisma.emailAccount.update.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "ea_1" });
    expect(call.data).toEqual({ name: "New", about: "Bio" });
  });

  // ---- SECURITY: excluded fields must not pass and must not call prisma.update ----

  const EXCLUDED_FIELDS: Array<[string, unknown]> = [
    ["apiKey", "leaked"],
    ["apiKeys", ["leaked"]],
    ["webhookUrl", "https://evil.example/hook"],
    ["webhookSecret", "x"],
    ["mcpClientId", "client_x"],
    ["aiModel", "gpt-4o"],
    ["aiProvider", "openai"],
    ["aiApiKey", "sk-x"],
    ["premiumId", "prem_x"],
    ["coldEmailPrompt", "..."],
    ["coldEmailBlocker", "DISABLED"],
    ["writingStyle", "casual"],
    ["behaviorProfile", { a: 1 }],
    ["personaAnalysis", { a: 1 }],
    ["digestSchedule", { intervalDays: 7 }],
    ["userId", "other-user"],
    ["accountId", "other-account"],
    ["includeReferralSignature", true],
    ["filingPrompt", "x"],
    ["rulesPrompt", "x"],
    ["autoCategorizeSenders", true],
    ["autoLearnPatterns", true],
    ["multiRuleSelectionEnabled", true],
    ["filingEnabled", true],
    ["allowHiddenAiDraftLinks", true],
    ["draftReplyConfidence", "STANDARD"],
    ["statsEmailFrequency", "WEEKLY"],
    ["summaryEmailFrequency", "WEEKLY"],
    ["meetingBriefingsEnabled", true],
    ["followUpAutoDraftEnabled", true],
    ["watchEmailsSubscriptionId", "sub_x"],
    ["lastSyncedHistoryId", "history_x"],
  ];

  it.each(
    EXCLUDED_FIELDS,
  )("rejects excluded field %s with VALIDATION_ERROR and does not call prisma.update", async (key, value) => {
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      [key]: value,
    });

    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    // The strict() schema names the offending key in the response details
    // so audit logs can identify it unambiguously.
    if (!out.ok) {
      const offendingKeys =
        (out.error.details as { offendingKeys?: string[] } | undefined)
          ?.offendingKeys ?? [];
      expect(offendingKeys).toContain(key);
    }
    // Defense in depth: no prisma write attempted.
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("rejects an excluded field even when mixed with an allowed one (no partial apply)", async () => {
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      about: "should NOT be saved",
      apiKey: "secret",
    });

    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  });

  it("rejects an unknown IANA timezone with VALIDATION_ERROR", async () => {
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      timezone: "Mars/Olympus_Mons",
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("rejects a non-http calendarBookingLink with VALIDATION_ERROR", async () => {
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      calendarBookingLink: "javascript:1",
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("rejects an empty object (at least one field required)", async () => {
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {});
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("returns NOT_FOUND when ctx points at a different user's account", async () => {
    // findFirst is scoped by userId; cross-user lookups return null.
    prisma.emailAccount.findFirst.mockResolvedValue(null as never);

    const out = await adminAccountUpdate(ctx("user_1", "ea_other"), {
      about: "x",
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "NOT_FOUND" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });

  it("rejects setting only taskpilotApiKey", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({ id: "ea_1" } as never);
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      taskpilotApiKey: "tk_x",
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects setting only taskpilotWorkspaceSlug", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue({ id: "ea_1" } as never);
    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      taskpilotWorkspaceSlug: "acme",
    });
    expect(out).toMatchObject({
      ok: false,
      error: { code: "VALIDATION_ERROR" },
    });
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("sets both taskpilot fields atomically and encrypts the key", async () => {
    prisma.emailAccount.findFirst
      .mockResolvedValueOnce({ id: "ea_1" } as never) // initial ownership check
      .mockResolvedValueOnce({
        ...baseRow,
        user: {
          taskpilotApiKey: "encrypted-blob",
          taskpilotWorkspaceSlug: "acme",
        },
      } as never); // getAccountProfile re-read
    prisma.user.update.mockResolvedValue({} as never);

    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      taskpilotApiKey: "tk_secret",
      taskpilotWorkspaceSlug: "acme",
    });

    expect(out).toMatchObject({
      ok: true,
      data: { taskpilot: { configured: true, workspaceSlug: "acme" } },
    });
    // EmailAccount not updated because the input contains no EmailAccount fields
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
    // User.update was called with an ENCRYPTED key (not the raw "tk_secret")
    const call = prisma.user.update.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
      data: {
        taskpilotApiKey: string | null;
        taskpilotWorkspaceSlug: string | null;
      };
    };
    expect(call.where).toEqual({ id: "user_1" });
    expect(call.data.taskpilotWorkspaceSlug).toBe("acme");
    expect(call.data.taskpilotApiKey).not.toBe("tk_secret");
    expect(call.data.taskpilotApiKey).toBeTruthy();
  });

  it("clears both fields when both are null", async () => {
    prisma.emailAccount.findFirst
      .mockResolvedValueOnce({ id: "ea_1" } as never)
      .mockResolvedValueOnce(baseRow as never);
    prisma.user.update.mockResolvedValue({} as never);

    const out = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      taskpilotApiKey: null,
      taskpilotWorkspaceSlug: null,
    });

    expect(out.ok).toBe(true);
    const call = prisma.user.update.mock.calls[0]?.[0] as {
      data: {
        taskpilotApiKey: string | null;
        taskpilotWorkspaceSlug: string | null;
      };
    };
    expect(call.data).toEqual({
      taskpilotApiKey: null,
      taskpilotWorkspaceSlug: null,
    });
  });
});

describe("admin_account_* integration: get → update → get", () => {
  it("get returns initial profile, update writes allowed fields, get returns the new values, and no credential keys leak", async () => {
    // First get
    prisma.emailAccount.findFirst.mockResolvedValueOnce(baseRow as never);
    const first = await adminAccountGet(ctx("user_1", "ea_1"), {});
    expect(first.ok).toBe(true);
    if (first.ok && first.data) {
      expect(first.data.about).toBe("About text");
    }

    // Update: ownership check, then emailAccount.update, then re-read via getAccountProfile
    prisma.emailAccount.findFirst
      .mockResolvedValueOnce({ id: "ea_1" } as never) // ownership check
      .mockResolvedValueOnce({
        ...baseRow,
        about: "Updated bio",
        timezone: "Asia/Jerusalem",
      } as never); // re-read at end of updateAccountProfile
    prisma.emailAccount.update.mockResolvedValueOnce({
      ...baseRow,
      about: "Updated bio",
      timezone: "Asia/Jerusalem",
    } as never);

    const update = await adminAccountUpdate(ctx("user_1", "ea_1"), {
      about: "Updated bio",
      timezone: "Asia/Jerusalem",
    });
    expect(update.ok).toBe(true);

    // Second get reflects update
    prisma.emailAccount.findFirst.mockResolvedValueOnce({
      ...baseRow,
      about: "Updated bio",
      timezone: "Asia/Jerusalem",
    } as never);
    const second = await adminAccountGet(ctx("user_1", "ea_1"), {});
    expect(second.ok).toBe(true);
    if (second.ok && second.data) {
      expect(second.data.about).toBe("Updated bio");
      expect(second.data.timezone).toBe("Asia/Jerusalem");
    }

    // Defense in depth: at no point did either tool emit credential fields.
    for (const out of [first, update, second]) {
      const json = JSON.stringify(out);
      expect(json).not.toContain("apiKey");
      expect(json).not.toContain("aiApiKey");
      expect(json).not.toContain("aiProvider");
      expect(json).not.toContain("aiModel");
      expect(json).not.toContain("webhookUrl");
    }
  });
});
