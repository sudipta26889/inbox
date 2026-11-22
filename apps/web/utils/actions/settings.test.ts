import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  updateSensitiveDataPolicyAction,
  updateAiSettingsAction,
} from "./settings";
import { APICallError } from "ai";
import { DEFAULT_PROVIDER, Provider } from "@/utils/llms/config";
import { getModel } from "@/utils/llms/model";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const { clearSpecificErrorMessagesMock, mockEnv, mockGenerateText } =
  vi.hoisted(() => ({
    clearSpecificErrorMessagesMock: vi.fn(),
    mockGenerateText: vi.fn(),
    mockEnv: {
      AZURE_RESOURCE_NAME: "azure-resource",
      EMAIL_ENCRYPT_SECRET: "test-email-secret",
      EMAIL_ENCRYPT_SALT: "test-email-salt",
      NEXT_PUBLIC_AI_MODEL_SETTINGS_DISABLED: false,
      NEXT_PUBLIC_SENSITIVE_DATA_POLICY_LOCKED: false,
    },
  }));

vi.mock("ai", async (importActual) => ({
  ...(await importActual<typeof import("ai")>()),
  generateText: mockGenerateText,
}));

vi.mock("@/utils/llms/model", async (importActual) => {
  const actual = await importActual<typeof import("@/utils/llms/model")>();
  return { ...actual, getModel: vi.fn(actual.getModel) };
});

vi.mock("@/env", () => ({
  env: mockEnv,
}));

vi.mock("@/utils/error-messages", async (importActual) => {
  const actual = await importActual<typeof import("@/utils/error-messages")>();

  return {
    ...actual,
    clearSpecificErrorMessages: clearSpecificErrorMessagesMock,
  };
});

describe("updateAiSettingsAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: Provider.LITELLM,
      aiApiKey: "stored-api-key",
    } as Awaited<ReturnType<typeof prisma.user.findUnique>>);
    prisma.user.updateMany.mockResolvedValue({ count: 1 } as never);
    mockEnv.NEXT_PUBLIC_AI_MODEL_SETTINGS_DISABLED = false;
    mockEnv.NEXT_PUBLIC_SENSITIVE_DATA_POLICY_LOCKED = false;
    mockGenerateText.mockResolvedValue({ text: "OK" });
  });

  it.each([
    Provider.OPEN_AI,
    Provider.ANTHROPIC,
    Provider.OPENROUTER,
    Provider.GOOGLE,
  ])("rejects the cloud provider %s, so personal data stays local", async (aiProvider) => {
    const result = await updateAiSettingsAction({
      aiProvider: aiProvider as never,
      aiModel: "some-model",
      aiApiKey: "new-api-key",
    });

    expect(result?.validationErrors).toBeTruthy();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects a model the gateway does not recognize", async () => {
    mockGenerateText.mockRejectedValueOnce(
      createApiCallError(404, "The model `flint-typo` does not exist"),
    );

    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "flint-typo",
      aiApiKey: "new-api-key",
    });

    expect(result?.serverError).toMatch(/model/i);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects an API key the gateway does not accept", async () => {
    mockGenerateText.mockRejectedValueOnce(
      createApiCallError(401, "Incorrect API key provided"),
    );

    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: "bad-api-key",
    });

    expect(result?.serverError).toMatch(/API key/i);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("still saves when the check fails for a reason unrelated to the settings", async () => {
    mockGenerateText.mockRejectedValueOnce(
      createApiCallError(503, "Service unavailable"),
    );

    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: "new-api-key",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.user.updateMany).toHaveBeenCalled();
  });

  it("checks the model with the stored key when the form leaves it blank", async () => {
    await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: undefined,
    });

    expect(getModel).toHaveBeenCalledWith(
      {
        aiProvider: Provider.LITELLM,
        aiModel: "recursivesi/flint",
        aiApiKey: "stored-api-key",
      },
      "default",
    );
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
  });

  it("does not check the model when switching back to the default provider", async () => {
    await updateAiSettingsAction({
      aiProvider: DEFAULT_PROVIDER,
      aiModel: "",
      aiApiKey: undefined,
    });

    expect(mockGenerateText).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).toHaveBeenCalled();
  });

  it("keeps the stored API key when the provider is unchanged and the form leaves it blank", async () => {
    await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: undefined,
    });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        aiProvider: Provider.LITELLM,
        aiModel: "recursivesi/flint",
        aiApiKey: "stored-api-key",
      },
    });
    expect(clearSpecificErrorMessagesMock).toHaveBeenCalled();
  });

  it("saves LiteLLM without a per-user key", async () => {
    prisma.user.findUnique.mockResolvedValue({
      aiProvider: null,
      aiApiKey: null,
    } as Awaited<ReturnType<typeof prisma.user.findUnique>>);

    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: undefined,
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: {
        aiProvider: Provider.LITELLM,
        aiModel: "recursivesi/flint",
        aiApiKey: null,
      },
    });
  });

  it("rejects a provider saved without a model", async () => {
    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "  ",
      aiApiKey: "key",
    });

    expect(result?.validationErrors).toBeTruthy();
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it("rejects account-level AI model updates when deployment settings are disabled", async () => {
    mockEnv.NEXT_PUBLIC_AI_MODEL_SETTINGS_DISABLED = true;

    const result = await updateAiSettingsAction({
      aiProvider: Provider.LITELLM,
      aiModel: "recursivesi/flint",
      aiApiKey: "new-api-key",
    });

    expect(result?.serverError).toBe(
      "AI model settings are managed by the deployment.",
    );
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });
});

describe("updateSensitiveDataPolicyAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.NEXT_PUBLIC_SENSITIVE_DATA_POLICY_LOCKED = false;
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: {
        userId: "user-1",
        provider: "google",
      },
    } as Awaited<ReturnType<typeof prisma.emailAccount.findUnique>>);
  });

  it("saves the account-level policy when deployment policy is editable", async () => {
    await updateSensitiveDataPolicyAction("email-account-1", {
      sensitiveDataPolicy: "REDACT",
    });

    expect(prisma.emailAccount.update).toHaveBeenCalledWith({
      where: { id: "email-account-1" },
      data: { sensitiveDataPolicy: "REDACT" },
    });
  });

  it("rejects account-level policy updates when deployment policy is locked", async () => {
    mockEnv.NEXT_PUBLIC_SENSITIVE_DATA_POLICY_LOCKED = true;

    const result = await updateSensitiveDataPolicyAction("email-account-1", {
      sensitiveDataPolicy: "BLOCK",
    });

    expect(result?.serverError).toBe(
      "Sensitive data protection is managed by the deployment.",
    );
    expect(prisma.emailAccount.update).not.toHaveBeenCalled();
  });
});

function createApiCallError(statusCode: number, message: string) {
  return new APICallError({
    message,
    url: "https://api.example.com/v1/responses",
    requestBodyValues: {},
    statusCode,
  });
}
