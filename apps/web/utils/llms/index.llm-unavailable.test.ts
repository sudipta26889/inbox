import {
  APICallError,
  NoObjectGeneratedError,
  RetryError,
  TypeValidationError,
} from "ai";
import { describe, expect, it, vi } from "vitest";
import { isLlmUnavailableError } from "./index";
import { FlintBusyError } from "./flint-stream";

vi.mock("@/env", () => ({
  env: { NODE_ENV: "test", NANO_LLMS: "", EMAIL_ENCRYPT_SALT: "test-salt" },
}));
vi.mock("@/utils/usage", () => ({ saveAiUsage: vi.fn() }));
vi.mock("@/utils/error-messages", () => ({
  addUserErrorMessageWithNotification: vi.fn(),
  ErrorType: {},
}));
vi.mock("@/utils/llms/model-usage-guard", () => ({
  assertTrialAiUsageAllowed: vi.fn(),
  shouldForceNanoModel: vi.fn().mockResolvedValue({ shouldForce: false }),
}));

function apiError(statusCode: number, message?: string) {
  return new APICallError({
    message: message ?? `status ${statusCode}`,
    url: "http://litellm.test/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    isRetryable: statusCode >= 500,
  });
}

describe("isLlmUnavailableError", () => {
  it("is true for a refused connection", () => {
    expect(
      isLlmUnavailableError(
        Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:4000"), {
          code: "ECONNREFUSED",
        }),
      ),
    ).toBe(true);
  });

  it("is true for a 503 from the gateway", () => {
    expect(isLlmUnavailableError(apiError(503))).toBe(true);
  });

  it("is true for a timeout or abort", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const abort = new Error("This operation was aborted");
    abort.name = "AbortError";

    expect(isLlmUnavailableError(timeout)).toBe(true);
    expect(isLlmUnavailableError(abort)).toBe(true);
    expect(isLlmUnavailableError(new Error("wrapped", { cause: abort }))).toBe(
      true,
    );
  });

  it("is true for a 408 or 429 from the gateway", () => {
    expect(isLlmUnavailableError(apiError(408))).toBe(true);
    expect(isLlmUnavailableError(apiError(429))).toBe(true);
  });

  it("is true when LM Studio is overloaded or unloading (400 terminated)", () => {
    expect(
      isLlmUnavailableError(
        apiError(
          400,
          "litellm.BadRequestError: Lm_studioException - 'terminated'",
        ),
      ),
    ).toBe(true);
  });

  it("is true when LM Studio has no model loaded (404)", () => {
    expect(
      isLlmUnavailableError(
        apiError(
          404,
          "litellm.NotFoundError: Lm_studioException - model not loaded",
        ),
      ),
    ).toBe(true);
  });

  it("is true for any retryable API call error", () => {
    expect(
      isLlmUnavailableError(
        new APICallError({
          message: "try again",
          url: "http://litellm.test/v1/chat/completions",
          requestBodyValues: {},
          statusCode: 409,
          isRetryable: true,
        }),
      ),
    ).toBe(true);
  });

  it("is true when a retry error's last error is one of these", () => {
    const retryError = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [
        apiError(500),
        apiError(
          400,
          "litellm.BadRequestError: Lm_studioException - 'terminated'",
        ),
      ],
    });

    expect(isLlmUnavailableError(retryError)).toBe(true);
  });

  it("is false for a request the model rejected", () => {
    expect(isLlmUnavailableError(apiError(400))).toBe(false);
    expect(isLlmUnavailableError(apiError(404))).toBe(false);
  });

  it("is true when the model produced no output before the token limit", () => {
    expect(
      isLlmUnavailableError(
        new NoObjectGeneratedError({
          message: "No object generated: could not parse the response.",
          text: "",
          response: {} as never,
          usage: {} as never,
          finishReason: "length",
        }),
      ),
    ).toBe(true);
  });

  it("is false for malformed JSON the model finished writing", () => {
    expect(
      isLlmUnavailableError(
        new NoObjectGeneratedError({
          message: "No object generated: could not parse the response.",
          text: "{not json",
          response: {} as never,
          usage: {} as never,
          finishReason: "stop",
        }),
      ),
    ).toBe(false);
  });

  it("is false for an invalid structured response", () => {
    expect(
      isLlmUnavailableError(
        new TypeValidationError({ value: {}, cause: new Error("bad shape") }),
      ),
    ).toBe(false);
  });

  it("is true when the Flint stream is busy, also wrapped by a retry error", () => {
    const busy = new FlintBusyError();

    expect(isLlmUnavailableError(busy)).toBe(true);
    expect(
      isLlmUnavailableError(
        new RetryError({
          message: "Failed after 3 attempts",
          reason: "maxRetriesExceeded",
          errors: [busy],
        }),
      ),
    ).toBe(true);
  });

  it("is false for an ordinary error", () => {
    expect(isLlmUnavailableError(new Error("Message not found"))).toBe(false);
  });
});
