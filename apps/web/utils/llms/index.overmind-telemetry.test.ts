import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGenerateText } from "./index";
import type { SelectModel } from "./model";

const {
  mockGenerateText,
  mockCaptureAiGeneration,
  mockGetPosthogLlmClient,
  mockIsPosthogLlmEvalApproved,
  mockGetOvermindTelemetry,
  mockIsOvermindTraceContentEnabled,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockCaptureAiGeneration: vi.fn(),
  mockGetPosthogLlmClient: vi.fn(),
  mockIsPosthogLlmEvalApproved: vi.fn(),
  mockGetOvermindTelemetry: vi.fn(),
  mockIsOvermindTraceContentEnabled: vi.fn(),
}));

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");
  return { ...actual, generateText: mockGenerateText };
});

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));

vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: mockGetPosthogLlmClient,
  isPosthogLlmEvalApproved: mockIsPosthogLlmEvalApproved,
}));

vi.mock("@posthog/ai", () => ({
  captureAiGeneration: mockCaptureAiGeneration,
}));

vi.mock("./overmind-telemetry", () => ({
  getOvermindTelemetry: mockGetOvermindTelemetry,
  isOvermindTraceContentEnabled: mockIsOvermindTraceContentEnabled,
}));

const overmind = { name: "overmind-integration" };

describe("Overmind telemetry on LLM calls", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGenerateText.mockResolvedValue({ text: "ok", usage: null });
    mockCaptureAiGeneration.mockResolvedValue(undefined);
    mockGetPosthogLlmClient.mockReturnValue(undefined);
    mockIsPosthogLlmEvalApproved.mockReturnValue(false);
    mockGetOvermindTelemetry.mockReturnValue(undefined);
    mockIsOvermindTraceContentEnabled.mockReturnValue(false);
  });

  it("leaves telemetry as it was when neither Overmind nor PostHog is set up", async () => {
    await callWithLabel("Choose rule");

    expect(telemetryOfCall()).toEqual({ isEnabled: true });
  });

  it("adds the label, the integration and no recorded content when content is off", async () => {
    mockGetOvermindTelemetry.mockReturnValue(overmind);

    await callWithLabel("Choose rule");

    expect(telemetryOfCall()).toEqual({
      isEnabled: true,
      functionId: "Choose rule",
      recordInputs: false,
      recordOutputs: false,
      integrations: [overmind],
    });
  });

  it("records inputs and outputs only when the content switch is on", async () => {
    mockGetOvermindTelemetry.mockReturnValue(overmind);
    mockIsOvermindTraceContentEnabled.mockReturnValue(true);

    await callWithLabel("Choose rule");

    expect(telemetryOfCall()).toEqual(
      expect.objectContaining({ recordInputs: true, recordOutputs: true }),
    );
  });

  it("keeps PostHog's integration next to Overmind's and its own privacy rules", async () => {
    mockGetOvermindTelemetry.mockReturnValue(overmind);
    mockGetPosthogLlmClient.mockReturnValue({ capture: vi.fn() });

    await callWithLabel("Draft reply");

    const telemetry = telemetryOfCall();
    expect(telemetry.functionId).toBe("Draft reply");
    expect(telemetry.recordInputs).toBe(false);
    expect(telemetry.recordOutputs).toBe(false);
    expect(telemetry.integrations).toHaveLength(2);
    expect(telemetry.integrations[1]).toBe(overmind);

    await telemetry.integrations[0].onStart({ prompt: "sensitive prompt" });
    await telemetry.integrations[0].onEnd({ text: "ok", finishReason: "stop" });
    expect(mockCaptureAiGeneration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ privacyMode: true }),
    );
  });

  it("the content switch does not switch off PostHog's privacy mode", async () => {
    mockGetOvermindTelemetry.mockReturnValue(overmind);
    mockIsOvermindTraceContentEnabled.mockReturnValue(true);
    mockGetPosthogLlmClient.mockReturnValue({ capture: vi.fn() });

    await callWithLabel("Draft reply");

    const telemetry = telemetryOfCall();
    expect(telemetry.recordInputs).toBe(true);

    await telemetry.integrations[0].onStart({ prompt: "sensitive prompt" });
    await telemetry.integrations[0].onEnd({ text: "ok", finishReason: "stop" });
    expect(mockCaptureAiGeneration).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ privacyMode: true }),
    );
  });
});

async function callWithLabel(label: string) {
  const model = { id: "model" } as SelectModel["model"];
  const generateText = createGenerateText({
    emailAccount: { email: "user@example.com", id: "account-1", userId: "u1" },
    label,
    modelOptions: {
      provider: "openai",
      modelName: "gpt-5-mini",
      model,
      fallbackModels: [],
      hasUserApiKey: false,
    },
    promptHardening: { trust: "trusted" },
  });

  await generateText({ prompt: "hello", model });
}

function telemetryOfCall() {
  return mockGenerateText.mock.calls[0][0].telemetry;
}
