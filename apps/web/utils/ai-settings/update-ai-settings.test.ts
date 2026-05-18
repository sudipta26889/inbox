import prisma from "@/utils/__mocks__/prisma";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";
import { NotFoundError, ValidationError } from "@/utils/mcp-server/errors";
import { describe, expect, it, vi } from "vitest";
import { updateAiSettings } from "./update-ai-settings";

vi.mock("@/utils/prisma");

describe("updateAiSettings", () => {
  it("updates provider and model for a real user", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await updateAiSettings(
      { userId: "user_1" },
      { aiProvider: Provider.ANTHROPIC, aiModel: "claude-4.7-sonnet" },
    );

    expect(result.aiProvider).toBe(Provider.ANTHROPIC);
    expect(result.aiModel).toBe("claude-4.7-sonnet");

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      where: { id: string };
      data: Record<string, unknown>;
    };
    expect(call.where).toEqual({ id: "user_1" });
    expect(call.data).toEqual({
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    });
  });

  it("clears aiProvider and aiModel when DEFAULT_PROVIDER is passed", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    const result = await updateAiSettings(
      { userId: "user_1" },
      { aiProvider: DEFAULT_PROVIDER, aiModel: "" },
    );

    expect(result.aiProvider).toBeNull();
    expect(result.aiModel).toBeNull();

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({ aiProvider: null, aiModel: null });
  });

  it("preserves the stored aiApiKey when switching to DEFAULT (MCP must not clear keys)", async () => {
    // The domain function MUST NOT write aiApiKey under any circumstances.
    // This is the contractual security guarantee for MCP callers.
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    await updateAiSettings(
      { userId: "user_1" },
      { aiProvider: DEFAULT_PROVIDER, aiModel: "" },
    );

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).not.toHaveProperty("aiApiKey");
  });

  it("preserves the stored aiApiKey when switching between non-DEFAULT providers", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    await updateAiSettings(
      { userId: "user_1" },
      { aiProvider: Provider.ANTHROPIC, aiModel: "claude-4.7-sonnet" },
    );

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).not.toHaveProperty("aiApiKey");
  });

  it("throws ValidationError when provider is not in the allowlist", async () => {
    await expect(
      updateAiSettings(
        { userId: "user_1" },
        { aiProvider: "fake-llm", aiModel: "x" },
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the user does not exist", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 } as never);

    await expect(
      updateAiSettings(
        { userId: "missing_user" },
        { aiProvider: Provider.ANTHROPIC, aiModel: "claude-4.7-sonnet" },
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
