import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

const mockEnv = vi.hoisted(() => ({
  NODE_ENV: "development",
  LOCAL_AUTH_BYPASS_ENABLED: true,
}));

vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("@/utils/prisma");

import { isLocalAuthBypassEnabled } from "./local-bypass-config";
import { isLocalBypassEmailAccount } from "./local-bypass-email-account";

describe("local auth bypass", () => {
  beforeEach(() => {
    mockEnv.NODE_ENV = "development";
    mockEnv.LOCAL_AUTH_BYPASS_ENABLED = true;
  });

  it("is never on outside development, even with the flag set", async () => {
    mockEnv.NODE_ENV = "production";

    expect(isLocalAuthBypassEnabled()).toBe(false);
    expect(await isLocalBypassEmailAccount("acc")).toBe(false);
    expect(prisma.emailAccount.findUnique).not.toHaveBeenCalled();
  });

  it("is off in development without the flag", () => {
    mockEnv.LOCAL_AUTH_BYPASS_ENABLED = false;

    expect(isLocalAuthBypassEnabled()).toBe(false);
  });

  it("recognises only the bypass user's own account", async () => {
    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      account: { providerAccountId: "local-bypass:user-1" },
    } as never);
    expect(await isLocalBypassEmailAccount("acc")).toBe(true);

    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      account: { providerAccountId: "1234567890" },
    } as never);
    expect(await isLocalBypassEmailAccount("acc")).toBe(false);
  });
});
