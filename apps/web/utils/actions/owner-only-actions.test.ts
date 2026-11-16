import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  createApiKeyAction,
  deactivateApiKeyAction,
} from "@/utils/actions/api-key";
import {
  shareEmailAccountAction,
  unshareEmailAccountAction,
  updateEmailAccountRoleAction,
} from "@/utils/actions/email-account";
import {
  createCustomMcpServerAction,
  removeCustomMcpServerAction,
} from "@/utils/actions/mcp";
import {
  createMessagingLinkCodeAction,
  linkSlackWorkspaceAction,
} from "@/utils/actions/messaging-channels";
import {
  createOrganizationAction,
  createOrganizationAndInviteAction,
  updateAnalyticsConsentAction,
} from "@/utils/actions/organization";
import { OWNER_ONLY_MESSAGE } from "@/utils/email-account-access";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "session-user", email: "session@example.com" },
    session: { emailOtp: false },
  })),
}));
vi.mock("@/utils/redis/account-validation", () => ({
  invalidateAccountValidation: vi.fn(),
}));
vi.mock("@/utils/mcp/tier-access", () => ({
  assertIntegrationsTierAccess: vi.fn(),
}));
vi.mock("@/utils/mcp/sync-tools", () => ({ syncMcpTools: vi.fn() }));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

// Each case names the write that must never happen for a shared user.
const cases = [
  {
    name: "createApiKey",
    run: () =>
      createApiKeyAction("acct-1", {
        name: "k",
        scopes: ["RULES_READ"],
        expiresIn: "30",
      } as never),
    write: () => prisma.apiKey.create,
  },
  {
    name: "deactivateApiKey",
    run: () => deactivateApiKeyAction("acct-1", { id: "key-1" }),
    write: () => prisma.apiKey.update,
  },
  {
    name: "createMessagingLinkCode",
    run: () =>
      createMessagingLinkCodeAction("acct-1", { provider: "TELEGRAM" }),
    write: () => prisma.messagingChannel.upsert,
  },
  {
    name: "linkSlackWorkspace",
    run: () => linkSlackWorkspaceAction("acct-1", { teamId: "T1" }),
    write: () => prisma.messagingChannel.findUnique,
  },
  {
    name: "createCustomMcpServer",
    run: () =>
      createCustomMcpServerAction("acct-1", {
        displayName: "Evil",
        serverUrl: "https://mcp.example.com",
        authType: "none",
      }),
    write: () => prisma.mcpIntegration.count,
  },
  {
    name: "removeCustomMcpServer",
    run: () => removeCustomMcpServerAction("acct-1", { name: "custom" }),
    write: () => prisma.mcpIntegration.deleteMany,
  },
  {
    name: "createOrganization",
    run: () =>
      createOrganizationAction("acct-1", { name: "Org", slug: "org" } as never),
    write: () => prisma.member.findFirst,
  },
  {
    name: "updateAnalyticsConsent",
    run: () =>
      updateAnalyticsConsentAction("acct-1", { allowOrgAdminAnalytics: true }),
    write: () => prisma.member.findFirst,
  },
  {
    name: "createOrganizationAndInvite",
    run: () =>
      createOrganizationAndInviteAction("acct-1", {
        emails: ["x@example.com"],
      }),
    write: () => prisma.organization.create,
  },
  {
    name: "updateEmailAccountRole",
    run: () => updateEmailAccountRoleAction("acct-1", { role: "Founder" }),
    write: () => prisma.user.update,
  },
  {
    name: "shareEmailAccount",
    run: () =>
      shareEmailAccountAction("acct-1", { email: "friend@example.com" }),
    write: () => prisma.emailAccountShare.upsert,
  },
  {
    name: "unshareEmailAccount",
    run: () => unshareEmailAccountAction("acct-1", { userId: "user-3" }),
    write: () => prisma.emailAccountShare.deleteMany,
  },
];

describe("owner-only actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(cases)("$name refuses a user the account is shared with", async ({
    run,
    write,
  }) => {
    mockAccountOwnedBy("owner-9");

    const result = await run();

    expect(result?.serverError).toBe(OWNER_ONLY_MESSAGE);
    expect(write()).not.toHaveBeenCalled();
  });

  it.each(cases)("$name lets the owner past the owner check", async ({
    run,
  }) => {
    mockAccountOwnedBy("session-user");

    const result = await run();

    expect(result?.serverError).not.toBe(OWNER_ONLY_MESSAGE);
    expect(result?.serverError).not.toBe("Unauthorized");
  });
});

function mockAccountOwnedBy(ownerUserId: string) {
  prisma.emailAccount.findUnique.mockResolvedValue({
    email: "mailbox@example.com",
    account: { userId: ownerUserId, provider: "google" },
  } as never);
}
