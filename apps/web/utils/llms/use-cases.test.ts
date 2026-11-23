import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Provider } from "./config";
import { getModel } from "./model";
import type { SelectModel } from "./model";
import type { UserAIFields } from "./types";
import {
  getModelForUseCase,
  INTERACTIVE_USE_CASES,
  LlmUseCase,
} from "./use-cases";
import { env } from "@/env";

vi.mock("@ai-sdk/openai", () => ({
  createOpenAI: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/azure", () => ({
  createAzure: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/google", () => ({
  createGoogle: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/google-vertex", () => ({
  createVertex: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/gateway", () => ({
  createGateway: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/groq", () => ({
  createGroq: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: vi.fn(() => ({
    chat: vi.fn((model: string) => ({ model })),
  })),
}));

vi.mock("ollama-ai-provider-v2", () => ({
  createOllama: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@ai-sdk/cerebras", () => ({
  createCerebras: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@/env", () => ({
  env: {
    DEFAULT_LLMS: "openrouter:openai/gpt-5.4-mini,openai:gpt-5.4-mini",
    DEFAULT_OPENROUTER_PROVIDERS: "Google Vertex,Anthropic",
    ECONOMY_LLMS:
      "openrouter:google/gemini-2.5-flash,anthropic:claude-3-5-haiku-latest",
    ECONOMY_OPENROUTER_PROVIDERS: "Google Vertex,Anthropic",
    CHAT_LLMS: "openrouter:moonshotai/kimi-k2,google:gemini-2.5-flash",
    CHAT_OPENROUTER_PROVIDERS: "Google Vertex,Anthropic",
    NANO_LLMS: undefined,
    DRAFT_LLMS: "openrouter:anthropic/claude-sonnet-4.6,openai:gpt-5.4-mini",
    LLM_API_KEY: undefined,
    OPENAI_API_KEY: "test-openai-key",
    AZURE_API_KEY: "test-azure-key",
    AZURE_RESOURCE_NAME: "test-azure-resource",
    AZURE_API_VERSION: "2024-10-21",
    GOOGLE_API_KEY: "test-google-key",
    GOOGLE_THINKING_BUDGET: undefined,
    GOOGLE_VERTEX_PROJECT: "test-vertex-project",
    GOOGLE_VERTEX_LOCATION: "us-central1",
    GOOGLE_VERTEX_CLIENT_EMAIL: undefined,
    GOOGLE_VERTEX_PRIVATE_KEY: undefined,
    GOOGLE_APPLICATION_CREDENTIALS: undefined,
    ANTHROPIC_API_KEY: "test-anthropic-key",
    GROQ_API_KEY: "test-groq-key",
    CEREBRAS_API_KEY: "test-cerebras-key",
    OPENROUTER_API_KEY: "test-openrouter-key",
    AI_GATEWAY_API_KEY: "test-ai-gateway-key",
    OLLAMA_BASE_URL: "http://localhost:11434/api",
    OLLAMA_MODEL: "llama3",
    OPENAI_COMPATIBLE_BASE_URL: "http://localhost:1234/v1",
    OPENAI_COMPATIBLE_MODEL: "llama-3.2-3b-instruct",
    OPENAI_COMPATIBLE_AUTH_HEADER: undefined,
    CLI_LLM_ENABLED: false,
    CODEX_CLI_ALLOW_NPX: false,
    CODEX_CLI_PATH: undefined,
    BEDROCK_REGION: "us-west-2",
    BEDROCK_ACCESS_KEY: "",
    BEDROCK_SECRET_KEY: "",
  },
}));

describe("LLM use cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    [LlmUseCase.CategorizeSender, "default"],
    [LlmUseCase.BulkInboxActionFilter, "economy"],
    [LlmUseCase.DraftReply, "draft"],
  ] as const)("delegates %s to getModel with the matching role", (useCase, modelType) => {
    const userAi = defaultUserAi();

    expect(modelSnapshot(getModelForUseCase(userAi, useCase))).toEqual(
      modelSnapshot(getModel(userAi, modelType)),
    );
  });

  describe("interactive and batch routing", () => {
    // Production sets no role lists, so a saved keyless LiteLLM model applies.
    const roleLists = [
      "DEFAULT_LLMS",
      "ECONOMY_LLMS",
      "CHAT_LLMS",
      "DRAFT_LLMS",
    ] as const;
    const savedRoleLists: Partial<Record<(typeof roleLists)[number], string>> =
      {};

    beforeEach(() => {
      for (const key of roleLists) {
        savedRoleLists[key] = env[key];
        (env as Record<string, unknown>)[key] = undefined;
      }
    });

    afterEach(() => {
      for (const key of roleLists) {
        (env as Record<string, unknown>)[key] = savedRoleLists[key];
      }
    });

    const flintUser = (aiApiKey: string | null = null) =>
      defaultUserAi({
        aiProvider: Provider.LITELLM,
        aiModel: "recursivesi/flint",
        aiApiKey,
      });

    const interactiveUseCases = [
      LlmUseCase.AssistantChat,
      LlmUseCase.ChatCompaction,
      LlmUseCase.ChatMemoryExtraction,
      LlmUseCase.ComposeAutocomplete,
      LlmUseCase.TranslateEmail,
      LlmUseCase.Summarise,
      LlmUseCase.PromptToRules,
      LlmUseCase.PromptToSplit,
      LlmUseCase.UnsubscribePageState,
      LlmUseCase.PersonaAnalysis,
      LlmUseCase.WritingStyleAnalysis,
      LlmUseCase.EmailReportActionableRecommendations,
      LlmUseCase.EmailReportEmailBehavior,
      LlmUseCase.EmailReportExecutiveSummary,
      LlmUseCase.EmailReportLabelAnalysis,
      LlmUseCase.EmailReportResponsePatterns,
      LlmUseCase.EmailReportSummaryGeneration,
      LlmUseCase.EmailReportUserPersona,
      LlmUseCase.CategorizeSendersBulk,
    ];

    it("lists exactly the use cases in the design as interactive", () => {
      expect([...INTERACTIVE_USE_CASES].sort()).toEqual(
        [...interactiveUseCases].sort(),
      );
    });

    it.each(
      interactiveUseCases,
    )("%s leaves Flint for gpt-oss-20b, with or without a saved key", (useCase) => {
      for (const userAi of [flintUser(), flintUser("sk-user-key")]) {
        const model = getModelForUseCase(userAi, useCase);

        expect(model.provider).toBe(Provider.LITELLM);
        expect(model.modelName).toBe("gpt-oss-20b");
        expect(model.interactive).toBe(true);
        expect(model.fallbackModels).toEqual([]);
      }
    });

    it("takes the interactive model from INTERACTIVE_LLMS", () => {
      env.INTERACTIVE_LLMS = "litellm:other-local";
      try {
        expect(
          getModelForUseCase(flintUser(), LlmUseCase.AssistantChat).modelName,
        ).toBe("other-local");
      } finally {
        env.INTERACTIVE_LLMS = undefined;
      }
    });

    it("falls back to the default when INTERACTIVE_LLMS is empty", () => {
      env.INTERACTIVE_LLMS = "";
      try {
        expect(
          getModelForUseCase(flintUser(), LlmUseCase.AssistantChat).modelName,
        ).toBe("gpt-oss-20b");
      } finally {
        env.INTERACTIVE_LLMS = undefined;
      }
    });

    it.each(
      Object.values(LlmUseCase).filter(
        (useCase) => !interactiveUseCases.includes(useCase),
      ),
    )("%s stays on the saved Flint model and is not interactive", (useCase) => {
      const model = getModelForUseCase(flintUser(), useCase);

      expect(model.modelName).toBe("recursivesi/flint");
      expect(model.interactive).toBeFalsy();
    });

    it("a direct getModel caller stays on Flint", () => {
      const model = getModel(flintUser(), "economy");

      expect(model.modelName).toBe("recursivesi/flint");
      expect(model.interactive).toBeFalsy();
    });
  });
});

function defaultUserAi(overrides?: Partial<UserAIFields>): UserAIFields {
  return {
    aiProvider: Provider.OPENROUTER,
    aiModel: null,
    aiApiKey: null,
    ...overrides,
  };
}

function modelSnapshot(modelOptions: SelectModel) {
  return {
    provider: modelOptions.provider,
    modelName: modelOptions.modelName,
    providerOptions: modelOptions.providerOptions,
    fallbackModels: modelOptions.fallbackModels.map((fallback) => ({
      provider: fallback.provider,
      modelName: fallback.modelName,
      providerOptions: fallback.providerOptions,
    })),
    hasUserApiKey: modelOptions.hasUserApiKey,
  };
}
