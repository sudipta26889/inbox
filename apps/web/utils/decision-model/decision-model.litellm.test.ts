import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDecisionModelConfig } from "./decision-model";
import { createSystemOneDecisionModel } from "./system-one";

// Production runs Jev as DEFAULT_DECISION_MODEL=litellm:typesafe/jev-latest:
// the LiteLLM gateway's /systemone route passes the System One protocol to
// TypeSafe, so the app never calls api.typesafe.ai itself.
vi.mock("./system-one", () => ({
  createSystemOneDecisionModel: vi.fn(() => ({ provider: "litellm" })),
}));
vi.mock("@/env", () => ({
  env: {
    LITELLM_BASE_URL: "http://litellm.test/v1/",
    LLM_API_KEY: "gateway-key",
    TYPESAFE_API_KEY: "typesafe-key",
  },
}));
vi.mock("@/utils/prisma");

describe("litellm decision model", () => {
  beforeEach(() => vi.clearAllMocks());

  it("routes Jev through the gateway's System One route", () => {
    const config = createDecisionModelConfig("litellm:typesafe/jev-latest");

    expect(config).toMatchObject({
      provider: "litellm",
      modelId: "typesafe/jev-latest",
    });
    expect(createSystemOneDecisionModel).toHaveBeenCalledWith({
      provider: "litellm",
      url: "http://litellm.test/v1/systemone",
      apiKey: "gateway-key",
      modelId: "typesafe/jev-latest",
    });
    expect(
      vi.mocked(createSystemOneDecisionModel).mock.calls[0][0].url,
    ).not.toContain("typesafe.ai");
  });
});
