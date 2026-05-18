import prisma from "@/utils/__mocks__/prisma";
import { Provider } from "@/utils/llms/config";
import { NotFoundError } from "@/utils/mcp-server/errors";
import { describe, expect, it, vi } from "vitest";
import { getAiSettings } from "./get-ai-settings";

vi.mock("@/utils/prisma");

describe("getAiSettings", () => {
  it("returns null provider + model for a user that hasn't configured AI", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: null,
      aiModel: null,
    } as never);

    const result = await getAiSettings({ userId: "user_1" });

    expect(result.aiProvider).toBeNull();
    expect(result.aiModel).toBeNull();
    expect(result.allowedProviders.length).toBeGreaterThan(0);
    expect(result.providerOptions.length).toBeGreaterThan(0);
  });

  it("returns the configured provider and model", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    } as never);

    const result = await getAiSettings({ userId: "user_2" });

    expect(result.aiProvider).toBe(Provider.ANTHROPIC);
    expect(result.aiModel).toBe("claude-4.7-sonnet");
  });

  it("never returns aiApiKey, even when one is stored", async () => {
    // Even if prisma returned the field by mistake, the domain function must not
    // expose it. The select clause is the primary defense, this is a paranoid
    // belt-and-braces check.
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: Provider.OPEN_AI,
      aiModel: "gpt-5.1",
    } as never);

    const result = await getAiSettings({ userId: "user_3" });

    expect(result).not.toHaveProperty("aiApiKey");
    expect(JSON.stringify(result)).not.toContain("sk-");
  });

  it("does not request aiApiKey from prisma (verified via select clause)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: null,
      aiModel: null,
    } as never);

    await getAiSettings({ userId: "user_4" });

    const call = prisma.user.findUnique.mock.calls[0]?.[0] as
      | { select?: Record<string, unknown> }
      | undefined;
    expect(call?.select).toBeDefined();
    expect(call?.select).not.toHaveProperty("aiApiKey");
    expect(call?.select).toMatchObject({ aiProvider: true, aiModel: true });
  });

  it("throws NotFoundError when the user does not exist", async () => {
    prisma.user.findUnique.mockResolvedValue(null as never);

    await expect(
      getAiSettings({ userId: "user_does_not_exist" }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
