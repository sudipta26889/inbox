import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {
    NODE_ENV: "development" as string,
    LOCAL_AUTH_BYPASS_ENABLED: true,
    LOCAL_AUTH_BYPASS_USER_EMAIL: undefined as string | undefined,
  },
}));
vi.mock("@/env", () => ({ env: mockEnv }));

import {
  getLocalBypassTargetEmail,
  LOCAL_BYPASS_USER_EMAIL,
} from "./local-bypass-config";
import { resolveBypassUser } from "./local-bypass-plugin";

const existingUser = { id: "user-real", email: "owner@example.com" };

function adapter(users: Record<string, { id: string; email: string }>) {
  return {
    findUserByEmail: vi.fn(async (email: string) =>
      users[email] ? { user: users[email] } : null,
    ),
    createUser: vi.fn(async (data: { email: string }) => ({
      id: "user-mock",
      email: data.email,
    })),
  };
}

describe("the bypass can sign in as an existing user", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NODE_ENV = "development";
    mockEnv.LOCAL_AUTH_BYPASS_ENABLED = true;
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = undefined;
    prisma.account.upsert.mockResolvedValue({ id: "acct-1" } as never);
  });

  it("signs in the existing user, creating nothing and attaching no mock mailbox", async () => {
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = "owner@example.com";
    const users = adapter({ "owner@example.com": existingUser });

    const user = await resolveBypassUser(users);

    expect(user).toBe(existingUser);
    expect(users.createUser).not.toHaveBeenCalled();
    expect(prisma.account.upsert).not.toHaveBeenCalled();
    expect(prisma.emailAccount.upsert).not.toHaveBeenCalled();
  });

  it("fails with a clear error when no user has that email", async () => {
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = "nobody@example.com";
    const users = adapter({ "owner@example.com": existingUser });

    await expect(resolveBypassUser(users)).rejects.toThrow(
      /LOCAL_AUTH_BYPASS_USER_EMAIL is set, but no user has the email nobody@example.com/,
    );
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it("is unchanged when the key is unset: the mock test user with a mock mailbox", async () => {
    const users = adapter({});

    const user = await resolveBypassUser(users);

    expect(users.findUserByEmail).toHaveBeenCalledWith(LOCAL_BYPASS_USER_EMAIL);
    expect(users.createUser).toHaveBeenCalledTimes(1);
    expect(user.email).toBe(LOCAL_BYPASS_USER_EMAIL);
    expect(prisma.account.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.emailAccount.upsert).toHaveBeenCalledTimes(1);
  });

  it("ignores the key when NODE_ENV is production", async () => {
    mockEnv.NODE_ENV = "production";
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = "owner@example.com";

    expect(getLocalBypassTargetEmail()).toBeUndefined();

    const users = adapter({ "owner@example.com": existingUser });
    const user = await resolveBypassUser(users);

    // Not the real user: the separate mock user, as before.
    expect(user.email).toBe(LOCAL_BYPASS_USER_EMAIL);
  });

  it("ignores the key when the bypass itself is off", () => {
    mockEnv.LOCAL_AUTH_BYPASS_ENABLED = false;
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = "owner@example.com";

    expect(getLocalBypassTargetEmail()).toBeUndefined();
  });

  it("is effective only when both gates are open, and trims the value", () => {
    mockEnv.LOCAL_AUTH_BYPASS_USER_EMAIL = " owner@example.com ";

    expect(getLocalBypassTargetEmail()).toBe("owner@example.com");

    mockEnv.NODE_ENV = "test";
    expect(getLocalBypassTargetEmail()).toBeUndefined();
  });
});
