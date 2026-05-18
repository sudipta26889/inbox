import prisma from "@/utils/__mocks__/prisma";
import { Provider } from "@/utils/llms/config";
import { describe, expect, it, vi } from "vitest";
import { adminAiGetSettings, adminAiUpdateModel } from "./admin-ai-tools";
import type { McpToolContext } from "./registry";

vi.mock("@/utils/prisma");

function ctx(userId: string, scopes: string[] = ["admin"]): McpToolContext {
  return {
    clientId: "test-client",
    emailAccountId: "test-email-account",
    userId,
    scopes,
  };
}

describe("admin_ai_get_settings", () => {
  it("returns current provider, model, and allowed-providers list", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    } as never);

    const res = await adminAiGetSettings(ctx("user_1"), {});

    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect(res.data.aiProvider).toBe(Provider.ANTHROPIC);
      expect(res.data.aiModel).toBe("claude-4.7-sonnet");
      expect(res.data.allowedProviders).toContain(Provider.ANTHROPIC);
      expect(
        res.data.providerOptions.find(
          (o: { value: string }) => o.value === Provider.ANTHROPIC,
        ),
      ).toBeTruthy();
    }
  });

  it("never leaks aiApiKey in the response payload", async () => {
    // Domain function selects only aiProvider/aiModel — even if the prisma
    // layer accidentally returned more, the envelope must not surface it.
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: Provider.OPEN_AI,
      aiModel: "gpt-5.1",
    } as never);

    const res = await adminAiGetSettings(ctx("user_1"), {});

    expect(JSON.stringify(res)).not.toContain("aiApiKey");
    if (res.ok && res.data) {
      expect(res.data).not.toHaveProperty("aiApiKey");
    }
  });

  it("does NOT request aiApiKey from prisma (select clause invariant)", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: null,
      aiModel: null,
    } as never);

    await adminAiGetSettings(ctx("user_1"), {});

    const call = prisma.user.findUnique.mock.calls[0]?.[0] as {
      select?: Record<string, unknown>;
    };
    expect(call.select).not.toHaveProperty("aiApiKey");
  });

  it("returns NOT_FOUND if the token user no longer exists", async () => {
    prisma.user.findUnique.mockResolvedValue(null as never);

    const res = await adminAiGetSettings(ctx("user_gone"), {});

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });
});

describe("admin_ai_update_model", () => {
  it("updates provider and model", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    const res = await adminAiUpdateModel(ctx("user_1"), {
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect(res.data.aiProvider).toBe(Provider.ANTHROPIC);
      expect(res.data.aiModel).toBe("claude-4.7-sonnet");
    }

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    });
    expect(call.data).not.toHaveProperty("aiApiKey");
  });

  // SECURITY: explicit api-key rejection paths required by Plan 08 spec
  it.each([
    ["aiApiKey", "sk-x"],
    ["apiKey", "sk-x"],
    ["secret", "x"],
    ["token", "x"],
    ["key", "x"],
    ["credentials", "x"],
  ])("rejects payload containing %s with VALIDATION_ERROR + reason=api_key_field_rejected", async (field, value) => {
    const res = await adminAiUpdateModel(ctx("user_1"), {
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
      [field]: value,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("VALIDATION_ERROR");
      expect(res.error.details).toMatchObject({
        reason: "api_key_field_rejected",
      });
    }

    // Defense in depth: prisma never invoked.
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects unknown provider with VALIDATION_ERROR", async () => {
    const res = await adminAiUpdateModel(ctx("user_1"), {
      aiProvider: "made-up-llm",
      aiModel: "x",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects when aiModel is missing", async () => {
    const res = await adminAiUpdateModel(ctx("user_1"), {
      aiProvider: Provider.ANTHROPIC,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("VALIDATION_ERROR");
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("clears provider/model when DEFAULT is passed (and does not touch aiApiKey)", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);

    const res = await adminAiUpdateModel(ctx("user_1"), {
      aiProvider: "DEFAULT",
      aiModel: "",
    });

    expect(res.ok).toBe(true);
    if (res.ok && res.data) {
      expect(res.data.aiProvider).toBeNull();
      expect(res.data.aiModel).toBeNull();
    }

    const call = prisma.user.updateMany.mock.calls[0]?.[0] as {
      data: Record<string, unknown>;
    };
    expect(call.data).toEqual({ aiProvider: null, aiModel: null });
    expect(call.data).not.toHaveProperty("aiApiKey");
  });

  it("returns NOT_FOUND when the token user has been deleted", async () => {
    prisma.user.updateMany.mockResolvedValue({ count: 0 } as never);

    const res = await adminAiUpdateModel(ctx("user_gone"), {
      aiProvider: Provider.ANTHROPIC,
      aiModel: "claude-4.7-sonnet",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("NOT_FOUND");
  });
});
