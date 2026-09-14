import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerateText } from "./index";
import type { SelectModel } from "./model";

const {
  mockGenerateText,
  mockSaveAiUsage,
  mockWithLLMRetry,
  mockWithNetworkRetry,
  mockExtractLLMErrorInfo,
  mockIsTransientNetworkError,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockSaveAiUsage: vi.fn(),
  mockWithLLMRetry: vi.fn(),
  mockWithNetworkRetry: vi.fn(),
  mockExtractLLMErrorInfo: vi.fn(),
  mockIsTransientNetworkError: vi.fn(),
}));

vi.mock("server-only", () => ({}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return {
    ...actual,
    generateText: mockGenerateText,
  };
});

vi.mock("@/utils/usage", () => ({
  saveAiUsage: mockSaveAiUsage,
}));

vi.mock("./retry", async () => {
  const actual = await vi.importActual<typeof import("./retry")>("./retry");
  return {
    ...actual,
    withLLMRetry: mockWithLLMRetry,
    withNetworkRetry: mockWithNetworkRetry,
    extractLLMErrorInfo: mockExtractLLMErrorInfo,
    isTransientNetworkError: mockIsTransientNetworkError,
  };
});

/**
 * The fallback chain never calls the model: it passes it to generateText and
 * compares it by identity, so an interface-shaped stub is enough.
 */
function mockModel(modelId: string): SelectModel["model"] {
  return {
    specificationVersion: "v3",
    provider: "test-provider",
    modelId,
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(),
  };
}

describe("createGenerateText fallback chain", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockWithLLMRetry.mockImplementation(
      async (operation: () => Promise<unknown>) => operation(),
    );
    mockWithNetworkRetry.mockImplementation(
      async (operation: () => Promise<unknown>) => operation(),
    );
    mockExtractLLMErrorInfo.mockReturnValue({
      retryable: false,
      isRateLimit: false,
      retryAfterMs: undefined,
    });
    mockIsTransientNetworkError.mockReturnValue(false);
    mockSaveAiUsage.mockResolvedValue(undefined);
  });

  it("falls back to the next provider on retryable provider failures", async () => {
    const primaryModel = mockModel("primary-model");
    const fallbackModel = mockModel("fallback-model");

    const modelOptions: SelectModel = {
      provider: "bedrock",
      modelName: "primary",
      model: primaryModel,
      providerOptions: undefined,
      fallbackModels: [
        {
          provider: "openrouter",
          modelName: "fallback",
          model: fallbackModel,
          providerOptions: undefined,
        },
      ],
      hasUserApiKey: false,
    };

    const retryableError = new Error("rate limited");
    mockExtractLLMErrorInfo.mockReturnValueOnce({
      retryable: true,
      isRateLimit: true,
      retryAfterMs: undefined,
    });

    mockGenerateText
      .mockRejectedValueOnce(retryableError)
      .mockResolvedValueOnce({
        text: "fallback success",
        usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
        toolCalls: [],
      });

    const generateText = createGenerateText({
      emailAccount: {
        email: "user@example.com",
        id: "email-account-1",
        userId: "user-1",
      },
      label: "Fallback Test",
      modelOptions,
    });

    const result = await generateText({
      prompt: "hello",
      model: primaryModel,
    });

    expect(result.text).toBe("fallback success");
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockGenerateText.mock.calls[0][0].model).toBe(primaryModel);
    expect(mockGenerateText.mock.calls[1][0].model).toBe(fallbackModel);
    expect(mockSaveAiUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openrouter",
        model: "fallback",
      }),
    );
  });

  it("reports the actual provider and model used for text generation", async () => {
    const model = mockModel("openai-model");
    const modelOptions: SelectModel = {
      provider: "openai",
      modelName: "gpt-5-mini",
      model: model,
      providerOptions: undefined,
      fallbackModels: [],
      hasUserApiKey: false,
    };

    mockGenerateText.mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      toolCalls: [],
    });

    const onModelUsed = vi.fn();
    const generateText = createGenerateText({
      emailAccount: {
        email: "user@example.com",
        id: "email-account-1",
        userId: "user-1",
      },
      label: "Model attribution",
      modelOptions,
      onModelUsed,
    });

    await generateText({
      prompt: "hello",
      model: model,
    });

    expect(onModelUsed).toHaveBeenCalledWith({
      provider: "openai",
      modelName: "gpt-5-mini",
    });
  });

  it("sets openrouter user from internal user id", async () => {
    const model = mockModel("openrouter-model");
    const modelOptions: SelectModel = {
      provider: "openrouter",
      modelName: "openrouter-primary",
      model: model,
      providerOptions: {
        openrouter: {
          provider: {
            order: ["Anthropic"],
          },
        },
      },
      fallbackModels: [],
      hasUserApiKey: false,
    };

    mockGenerateText.mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      toolCalls: [],
    });

    const generateText = createGenerateText({
      emailAccount: {
        email: "user@example.com",
        id: "email-account-1",
        userId: "user-123",
      },
      label: "OpenRouter user metadata",
      modelOptions,
    });

    await generateText({
      prompt: "hello",
      model: model,
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const providerOptions = mockGenerateText.mock.calls[0][0].providerOptions;
    expect(providerOptions.openrouter.user).toBe("user-123");
    expect(providerOptions.openrouter.provider).toEqual({
      order: ["Anthropic"],
    });
    expect(providerOptions.openrouter.trace.trace_name).toBe(
      "OpenRouter user metadata",
    );
    expect(providerOptions.openrouter.trace.generation_name).toBe(
      "OpenRouter user metadata",
    );
    expect(providerOptions.openrouter.trace.email_account_id).toBe(
      "email-account-1",
    );
  });

  it("keeps explicit openrouter user and trace when request provides them", async () => {
    const model = mockModel("openrouter-model");
    const modelOptions: SelectModel = {
      provider: "openrouter",
      modelName: "openrouter-primary",
      model: model,
      providerOptions: undefined,
      fallbackModels: [],
      hasUserApiKey: false,
    };

    mockGenerateText.mockResolvedValue({
      text: "ok",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      toolCalls: [],
    });

    const generateText = createGenerateText({
      emailAccount: {
        email: "user@example.com",
        id: "email-account-1",
        userId: "internal-user-id",
      },
      label: "OpenRouter user override",
      modelOptions,
    });

    await generateText({
      prompt: "hello",
      model: model,
      providerOptions: {
        openrouter: {
          user: "explicit-user-id",
          trace: {
            trace_name: "explicit-trace",
            generation_name: "explicit-generation",
            email_account_id: "explicit-email-account-id",
          },
        },
      },
    });

    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const providerOptions = mockGenerateText.mock.calls[0][0].providerOptions;
    expect(providerOptions.openrouter.user).toBe("explicit-user-id");
    expect(providerOptions.openrouter.trace).toEqual({
      trace_name: "explicit-trace",
      generation_name: "explicit-generation",
      email_account_id: "explicit-email-account-id",
    });
  });
});
