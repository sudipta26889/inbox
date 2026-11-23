import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FLINT_MAX_WAIT_MS } from "./flint-stream";

const { mockGenerateObject, mockGenerateText, mockShouldForceNanoModel } =
  vi.hoisted(() => ({
    mockGenerateObject: vi.fn(),
    mockGenerateText: vi.fn(),
    mockShouldForceNanoModel: vi.fn(),
  }));

vi.mock("ai", () => ({
  APICallError: { isInstance: () => false },
  RetryError: { isInstance: () => false },
  NoObjectGeneratedError: { isInstance: () => false },
  TypeValidationError: { isInstance: () => false },
  ToolLoopAgent: class {},
  generateObject: mockGenerateObject,
  generateText: mockGenerateText,
  streamText: vi.fn(),
  smoothStream: vi.fn(),
  stepCountIs: vi.fn(),
  isStepCount: vi.fn(),
}));

vi.mock("@posthog/ai", () => ({ captureAiGeneration: vi.fn() }));

vi.mock("@/env", () => ({
  env: {
    NODE_ENV: "test",
    NANO_LLMS: "",
    NEXT_PUBLIC_POSTHOG_KEY: "",
    EMAIL_ENCRYPT_SALT: "test-salt",
  },
}));

vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));
vi.mock("@/utils/sleep", () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/error-messages", () => ({
  addUserErrorMessageWithNotification: vi.fn(),
  ErrorType: {},
}));
vi.mock("@/utils/error", () => ({
  attachLlmRepairMetadata: vi.fn(),
  captureException: vi.fn(),
  getAIApiCallError: vi.fn(() => null),
  isAnthropicInsufficientBalanceError: vi.fn(() => false),
  isContentFilterRefusal: vi.fn(() => false),
  isIncorrectAPIKeyError: vi.fn(() => false),
  isGeminiSpendingCapError: vi.fn(() => false),
  isInsufficientCreditsError: vi.fn(() => false),
  isInvalidAIModelError: vi.fn(() => false),
  isAPIKeyDeactivatedError: vi.fn(() => false),
  isAiQuotaExceededError: vi.fn(() => false),
  markAsHandledUserKeyError: vi.fn(),
  SafeError: class SafeError extends Error {},
}));
vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: mockShouldForceNanoModel,
}));
vi.mock("@/utils/posthog", () => ({
  getPosthogLlmClient: vi.fn(() => undefined),
  isPosthogLlmEvalApproved: vi.fn(() => false),
}));

const FLINT = "recursivesi/flint";
const objectArgs = {
  instructions: "Return JSON.",
  prompt: "Return JSON.",
  schema: {} as never,
} as never;

describe("Flint batch harness in createGenerateObject / createGenerateText", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockShouldForceNanoModel.mockResolvedValue({ shouldForce: false });
    mockGenerateObject.mockReset().mockResolvedValue({
      object: { ok: true },
      usage: { outputTokens: 10 },
    });
    mockGenerateText.mockReset().mockResolvedValue({
      text: "hi",
      usage: { outputTokens: 10 },
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps a Flint object call's output at 8192", async () => {
    const generateObject = await createObject({ modelName: FLINT });

    await generateObject(objectArgs);

    expect(mockGenerateObject.mock.calls[0][0].maxOutputTokens).toBe(8192);
  });

  it("keeps a caller's own maxOutputTokens on a Flint call", async () => {
    const generateObject = await createObject({ modelName: FLINT });

    await generateObject({
      ...(objectArgs as object),
      maxOutputTokens: 500,
    } as never);

    expect(mockGenerateObject.mock.calls[0][0].maxOutputTokens).toBe(500);
  });

  it("does not cap calls to other models", async () => {
    const generateObject = await createObject({ modelName: "gpt-oss-20b" });

    await generateObject(objectArgs);

    expect(mockGenerateObject.mock.calls[0][0].maxOutputTokens).toBeUndefined();
  });

  it("runs five parallel Flint calls (the draft shape) one at a time, all completing", async () => {
    let running = 0;
    let maxRunning = 0;
    mockGenerateObject.mockReset().mockImplementation(async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      await new Promise((resolve) => setTimeout(resolve, 100));
      running--;
      return { object: { ok: true }, usage: { outputTokens: 1 } };
    });
    vi.useFakeTimers();
    const generateObject = await createObject({ modelName: FLINT });

    const calls = Array.from({ length: 5 }, () => generateObject(objectArgs));
    await vi.advanceTimersByTimeAsync(2000);
    const results = await Promise.allSettled(calls);

    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(mockGenerateObject).toHaveBeenCalledTimes(5);
    expect(maxRunning).toBe(1);
  });

  it("does not make an interactive call wait behind a running Flint call", async () => {
    const blocker = deferred();
    mockGenerateObject
      .mockReset()
      .mockImplementation((options) =>
        options.prompt === "slow"
          ? blocker.promise
          : Promise.resolve({ object: { ok: true }, usage: null }),
      );
    const flint = await createObject({ modelName: FLINT });
    const interactive = await createObject({
      modelName: FLINT,
      interactive: true,
    });

    const running = flint({
      ...(objectArgs as object),
      prompt: "slow",
    } as never);
    await expect(interactive(objectArgs)).resolves.toBeDefined();

    blocker.resolve({ object: { ok: true }, usage: null });
    await running;
  });

  it("defers a call that waited past the cap as 'unavailable', and the queue keeps working", async () => {
    vi.useFakeTimers();
    const blocker = deferred();
    mockGenerateObject
      .mockReset()
      .mockImplementationOnce(() => blocker.promise)
      .mockResolvedValue({ object: { ok: true }, usage: null });
    const { isLlmUnavailableError } = await import("./index");
    const generateObject = await createObject({ modelName: FLINT });

    const first = generateObject(objectArgs);
    const second = generateObject(objectArgs).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(FLINT_MAX_WAIT_MS + 1000);
    const error = await second;

    expect(isLlmUnavailableError(error)).toBe(true);
    expect(mockGenerateObject).toHaveBeenCalledTimes(1);

    blocker.resolve({ object: { ok: true }, usage: null });
    await first;
    await expect(generateObject(objectArgs)).resolves.toBeDefined();
    expect(mockGenerateObject).toHaveBeenCalledTimes(2);
  });

  it("frees the slot when the model call throws", async () => {
    mockGenerateObject
      .mockReset()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue({ object: { ok: true }, usage: null });
    const generateObject = await createObject({ modelName: FLINT });

    await expect(generateObject(objectArgs)).rejects.toThrow("boom");
    await expect(generateObject(objectArgs)).resolves.toBeDefined();
  });

  it("caps and queues a Flint text call the same way", async () => {
    const generateText = await createText({ modelName: FLINT });

    await generateText({ prompt: "hello" } as never);

    expect(mockGenerateText.mock.calls[0][0].maxOutputTokens).toBe(8192);
  });

  it("defers a text call that waited past the cap as unavailable", async () => {
    vi.useFakeTimers();
    const blocker = deferred();
    mockGenerateText
      .mockReset()
      .mockImplementationOnce(() => blocker.promise)
      .mockResolvedValue({ text: "x", usage: null });
    const { isLlmUnavailableError } = await import("./index");
    const generateText = await createText({ modelName: FLINT });

    const first = generateText({ prompt: "a" } as never);
    const second = generateText({ prompt: "b" } as never).catch(
      (e: unknown) => e,
    );

    await vi.advanceTimersByTimeAsync(FLINT_MAX_WAIT_MS + 1000);

    expect(isLlmUnavailableError(await second)).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);

    blocker.resolve({ text: "a", usage: null });
    await first;
  });

  it("the nano cost guard never moves an interactive call", async () => {
    mockShouldForceNanoModel.mockResolvedValue({ shouldForce: true });
    const generateObject = await createObject({
      modelName: "gpt-oss-20b",
      interactive: true,
    });

    await generateObject(objectArgs);

    expect(mockShouldForceNanoModel).not.toHaveBeenCalled();
  });
});

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function modelOptions({
  modelName,
  interactive,
}: {
  modelName: string;
  interactive?: boolean;
}) {
  return {
    provider: "litellm",
    modelName,
    model: { provider: "litellm", modelId: modelName },
    providerOptions: undefined,
    fallbackModels: [],
    hasUserApiKey: false,
    ...(interactive ? { interactive: true } : {}),
  } as never;
}

const emailAccount = {
  id: "account-1",
  email: "user@example.com",
  userId: "user-1",
};

async function createObject(options: {
  modelName: string;
  interactive?: boolean;
}) {
  const { createGenerateObject } = await import("./index");
  return createGenerateObject({
    emailAccount,
    label: "test",
    modelOptions: modelOptions(options),
    promptHardening: { trust: "untrusted", level: "full" },
  });
}

async function createText(options: {
  modelName: string;
  interactive?: boolean;
}) {
  const { createGenerateText } = await import("./index");
  return createGenerateText({
    emailAccount,
    label: "test",
    modelOptions: modelOptions(options),
    promptHardening: { trust: "untrusted", level: "full" },
  });
}
