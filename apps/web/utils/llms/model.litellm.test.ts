import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { env } from "@/env";
import { getModel } from "./model";

// Every model call goes through the homelab LiteLLM gateway. The deployment
// chain (DEFAULT_LLMS) and the per-user rows saved before the re-fork
// (aiProvider "litellm", a LiteLLM virtual key, e.g. deepseek-v4-flash) must
// both resolve to it.
vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: vi.fn(() => (model: string) => ({ model })),
}));

vi.mock("@/env", () => ({
  env: {
    DEFAULT_LLMS: "litellm:nemotron-3-nano-cloud",
    DEFAULT_LLM_MODEL: "nemotron-3-nano-cloud",
    ECONOMY_LLMS: undefined as string | undefined,
    LITELLM_BASE_URL: "http://litellm.test/v1",
    LLM_API_KEY: "deployment-key",
  },
}));

describe("LiteLLM provider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes the deployment default chain to the gateway", () => {
    const model = getModel({
      aiProvider: null,
      aiModel: null,
      aiApiKey: null,
    });

    expect(model.provider).toBe("litellm");
    expect(model.modelName).toBe("nemotron-3-nano-cloud");
    expect(createOpenAICompatible).toHaveBeenCalledWith({
      name: "litellm",
      baseURL: "http://litellm.test/v1",
      supportsStructuredOutputs: true,
      apiKey: "deployment-key",
    });
  });

  // Flint rejects response_format json_object with HTTP 400; the SDK sends
  // json_schema only when the provider declares structured output support.
  it("requests json_schema structured outputs from the gateway", () => {
    getModel({ aiProvider: null, aiModel: null, aiApiKey: null });

    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "litellm",
        supportsStructuredOutputs: true,
      }),
    );
  });

  it("keeps a user's saved LiteLLM model and virtual key", () => {
    const model = getModel({
      aiProvider: "litellm",
      aiModel: "deepseek-v4-flash",
      aiApiKey: "user-virtual-key",
    });

    expect(model.modelName).toBe("deepseek-v4-flash");
    expect(createOpenAICompatible).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "user-virtual-key" }),
    );
    // Reasoning models get a bounded thinking budget through the gateway.
    expect(model.providerOptions).toEqual({
      openaiCompatible: { reasoningEffort: "medium" },
    });
  });

  it("leaves non-reasoning models without provider options", () => {
    expect(
      getModel({ aiProvider: null, aiModel: null, aiApiKey: null })
        .providerOptions,
    ).toBeUndefined();
  });

  it("is skipped from the chain when it has no key", () => {
    vi.mocked(env).LLM_API_KEY = undefined;

    expect(() =>
      getModel({ aiProvider: null, aiModel: null, aiApiKey: null }),
    ).toThrow();

    vi.mocked(env).LLM_API_KEY = "deployment-key";
  });

  // sudipta_main's selectDefaultModel: a saved choice wins whether or not the
  // user has a key, and a saved provider without a model uses
  // DEFAULT_LLM_MODEL.
  describe("matches sudipta_main's model selection", () => {
    it("keeps a saved LiteLLM model when the user has no key", () => {
      const model = getModel(
        { aiProvider: "litellm", aiModel: "deepseek-v4-flash", aiApiKey: null },
        "economy",
      );

      expect(model.provider).toBe("litellm");
      expect(model.modelName).toBe("deepseek-v4-flash");
      expect(createOpenAICompatible).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "deployment-key" }),
      );
    });

    it("falls back to DEFAULT_LLM_MODEL for a saved provider with no model", () => {
      for (const aiApiKey of ["user-virtual-key", null]) {
        const model = getModel({
          aiProvider: "litellm",
          aiModel: null,
          aiApiKey,
        });

        expect(model.modelName).toBe("nemotron-3-nano-cloud");
      }
    });

    it("uses an explicitly configured role model for a keyless user", () => {
      vi.mocked(env).ECONOMY_LLMS = "litellm:qwen3-economy";

      const model = getModel(
        { aiProvider: "litellm", aiModel: "deepseek-v4-flash", aiApiKey: null },
        "economy",
      );

      expect(model.modelName).toBe("qwen3-economy");
      vi.mocked(env).ECONOMY_LLMS = undefined;
    });
  });
});
