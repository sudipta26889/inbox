import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import { buildMcpToolContext } from "@/utils/mcp-server/tool-context";

vi.mock("@/utils/prisma", () => ({
  default: { emailAccount: { findFirst: vi.fn() } },
}));

const base = { emailAccountId: "acct-1", clientId: "c", scopes: [] };

describe("buildMcpToolContext", () => {
  it("runs a shared account as its owner while remembering the caller", async () => {
    vi.mocked(prisma.emailAccount.findFirst).mockResolvedValue({
      userId: "owner",
    } as never);

    const context = await buildMcpToolContext({ ...base, userId: "caller" });

    expect(context).toMatchObject({ userId: "owner", callerUserId: "caller" });
  });

  it("returns null once the caller has lost access", async () => {
    vi.mocked(prisma.emailAccount.findFirst).mockResolvedValue(null);

    expect(await buildMcpToolContext({ ...base, userId: "caller" })).toBeNull();
  });
});
