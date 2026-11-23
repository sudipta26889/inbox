import { readFileSync } from "node:fs";
import path from "node:path";
import { generateText, jsonSchema, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "@/env";
import {
  CAPABILITY_ID_BY_LABEL,
  createOvermindTelemetry,
  getCapabilityIdForLabel,
  getOvermindTelemetry,
  isOvermindTraceContentEnabled,
} from "./overmind-telemetry";

vi.mock("@/env", () => ({
  env: {
    OVERMIND_API_URL: undefined,
    OVERMIND_API_KEY: undefined,
    OVERMIND_TRACE_CONTENT: undefined,
  },
}));

const SECRET_API_KEY = "ZXQ-overmind-api-key";
const SECRET_HEADER = "Bearer ZXQ-request-header-token";
const CONTENT = {
  system: "ZXQ-system-instructions",
  prompt: "ZXQ-user-prompt",
  output: "ZXQ-model-output",
  toolArg: "ZXQ-tool-argument",
  toolResult: "ZXQ-tool-result",
  error: "ZXQ-error-text-from-model",
};

describe("capability map", () => {
  it("only uses capability ids that exist in the repo's overmind.toml", () => {
    const toml = readFileSync(
      path.resolve(import.meta.dirname, "../../../../overmind.toml"),
      "utf8",
    );
    const known = new Set(
      [...toml.matchAll(/^id = "([0-9a-f-]{36})"$/gm)].map((m) => m[1]),
    );

    expect(known.size).toBeGreaterThan(10);
    for (const [label, id] of Object.entries(CAPABILITY_ID_BY_LABEL)) {
      expect(known.has(id), `${label} -> ${id}`).toBe(true);
    }
  });

  it.each([
    ["assistant-chat", "e79228df-ab7b-4ce0-aac0-3cd068baaa22"],
    ["Cold email check", "de430b7d-7512-462c-901b-8a3f468b30c9"],
    ["Choose rule", "b1898fe8-4c2d-441c-b2c0-df045463d224"],
    ["Draft reply", "4f5ae617-c56c-449f-8013-e082f460fd50"],
    ["Categorize senders bulk", "ffbc5026-793c-4635-927d-4e104dbe14f1"],
    ["email-report-user-persona", "bf02781d-1eff-4df8-968c-f1a34d64cdc5"],
  ])("maps the current label %s", (label, id) => {
    expect(getCapabilityIdForLabel(label)).toBe(id);
  });

  it("leaves labels the toml does not cover unmapped", () => {
    expect(getCapabilityIdForLabel("Some new label")).toBeUndefined();
  });
});

describe("getOvermindTelemetry", () => {
  beforeEach(() => {
    env.OVERMIND_API_URL = undefined;
    env.OVERMIND_API_KEY = undefined;
    env.OVERMIND_TRACE_CONTENT = undefined;
  });

  it("is off unless both the URL and the key are set", () => {
    expect(getOvermindTelemetry()).toBeUndefined();

    env.OVERMIND_API_URL = "http://overmind.test";
    expect(getOvermindTelemetry()).toBeUndefined();

    env.OVERMIND_API_URL = undefined;
    env.OVERMIND_API_KEY = SECRET_API_KEY;
    expect(getOvermindTelemetry()).toBeUndefined();
  });

  it("is created once, on first use, when both are set", () => {
    env.OVERMIND_API_URL = "http://overmind.test";
    env.OVERMIND_API_KEY = SECRET_API_KEY;

    const first = getOvermindTelemetry();
    expect(first).toBeDefined();
    expect(getOvermindTelemetry()).toBe(first);
  });

  it("includes content only when OVERMIND_TRACE_CONTENT is exactly 1", () => {
    expect(isOvermindTraceContentEnabled()).toBe(false);

    for (const value of ["", "0", "true", "yes", "on"]) {
      env.OVERMIND_TRACE_CONTENT = value;
      expect(isOvermindTraceContentEnabled()).toBe(false);
    }

    env.OVERMIND_TRACE_CONTENT = "1";
    expect(isOvermindTraceContentEnabled()).toBe(true);
  });
});

describe("exported spans", () => {
  beforeEach(() => {
    env.OVERMIND_API_URL = "http://overmind.test";
    env.OVERMIND_API_KEY = SECRET_API_KEY;
    env.OVERMIND_TRACE_CONTENT = undefined;
  });

  it("carries no prompt, output, tool or error text and no secrets with content off", async () => {
    const { spans } = await runCalls({ content: false });

    expect(spans.length).toBeGreaterThan(2);
    const dump = dumpSpans(spans);
    for (const text of Object.values(CONTENT)) {
      expect(dump, text).not.toContain(text);
    }
    expect(dump).not.toContain(SECRET_API_KEY);
    expect(dump).not.toContain(SECRET_HEADER);
    expect(dump).not.toContain("ZXQ-request-header-token");
  });

  it("still carries the metadata: label, capability id, model, usage, error type", async () => {
    const { spans, errorSpans } = await runCalls({ content: false });

    const labels = new Set(
      spans.map((span) => span.attributes["ai.telemetry.functionId"]),
    );
    expect(labels).toContain("Choose rule");
    const stamped = spans.filter(
      (span) => span.attributes["overmind.capability.id"],
    );
    expect(stamped.length).toBeGreaterThan(0);
    expect(
      stamped.every(
        (span) =>
          span.attributes["overmind.capability.id"] ===
          getCapabilityIdForLabel(
            String(span.attributes["ai.telemetry.functionId"]),
          ),
      ),
    ).toBe(true);
    expect(
      spans.some((span) => span.attributes["ai.usage.outputTokens"] != null),
    ).toBe(true);
    expect(
      spans.some((span) => span.attributes["ai.model.id"] === "mock-model-id"),
    ).toBe(true);

    expect(errorSpans.length).toBeGreaterThan(0);
    const exceptionEvents = errorSpans.flatMap((span) =>
      span.events.filter((event) => event.name === "exception"),
    );
    expect(exceptionEvents.length).toBeGreaterThan(0);
    expect(
      exceptionEvents.every(
        (event) => typeof event.attributes?.["exception.type"] === "string",
      ),
    ).toBe(true);
  });

  it("records the prompt and output when content is on, but never secrets", async () => {
    env.OVERMIND_TRACE_CONTENT = "1";

    const { spans } = await runCalls({ content: true });

    const dump = dumpSpans(spans);
    expect(dump).toContain(CONTENT.prompt);
    expect(dump).toContain(CONTENT.output);
    expect(dump).not.toContain(SECRET_API_KEY);
    expect(dump).not.toContain("ZXQ-request-header-token");
  });

  it("lists the attribute keys exported with content off", async () => {
    const { spans } = await runCalls({ content: false });
    const keys = [
      ...new Set(spans.flatMap((span) => Object.keys(span.attributes))),
    ].sort();

    // A new key here is a new thing exported to Overmind: review it first.
    expect(keys).toEqual([
      "ai.model.id",
      "ai.model.provider",
      "ai.operationId",
      "ai.response.finishReason",
      "ai.response.id",
      "ai.response.model",
      "ai.response.timestamp",
      "ai.settings.maxRetries",
      "ai.telemetry.functionId",
      "ai.toolCall.id",
      "ai.toolCall.name",
      "ai.usage.inputTokenDetails.noCacheTokens",
      "ai.usage.inputTokens",
      "ai.usage.outputTokenDetails.textTokens",
      "ai.usage.outputTokens",
      "ai.usage.totalTokens",
      "gen_ai.request.model",
      "gen_ai.response.finish_reasons",
      "gen_ai.response.id",
      "gen_ai.response.model",
      "gen_ai.usage.input_tokens",
      "gen_ai.usage.output_tokens",
      "operation.name",
      "overmind.capability.id",
      "resource.name",
    ]);
  });
});

async function runCalls({ content }: { content: boolean }) {
  const exporter = new InMemorySpanExporter();
  const integration = createOvermindTelemetry(
    exporter,
    (inner) => new SimpleSpanProcessor(inner),
  );
  const telemetry = {
    isEnabled: true,
    functionId: "Choose rule",
    recordInputs: content,
    recordOutputs: content,
    integrations: [integration],
  };

  await generateText({
    model: textModel(),
    instructions: CONTENT.system,
    prompt: CONTENT.prompt,
    headers: { Authorization: SECRET_HEADER },
    telemetry,
  });

  await generateText({
    model: toolCallModel(),
    prompt: CONTENT.prompt,
    tools: {
      lookup: tool({
        description: "Looks something up",
        inputSchema: jsonSchema({
          type: "object",
          properties: { q: { type: "string" } },
        }),
        execute: async () => CONTENT.toolResult,
      }),
    },
    stopWhen: () => true,
    headers: { Authorization: SECRET_HEADER },
    telemetry: { ...telemetry, functionId: "assistant-chat" },
  });

  await generateText({
    model: failingModel(),
    prompt: CONTENT.prompt,
    maxRetries: 0,
    headers: { Authorization: SECRET_HEADER },
    telemetry,
  }).catch(() => undefined);

  const spans = exporter.getFinishedSpans();
  const errorSpans = spans.filter((span) =>
    span.events.some((event) => event.name === "exception"),
  );
  return { spans, errorSpans };
}

function dumpSpans(
  spans: ReturnType<InMemorySpanExporter["getFinishedSpans"]>,
) {
  return JSON.stringify(
    spans.map((span) => ({
      name: span.name,
      attributes: span.attributes,
      events: span.events,
      status: span.status,
      resource: span.resource.attributes,
    })),
  );
}

const usage = {
  inputTokens: {
    total: 3,
    noCache: 3,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

function textModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: CONTENT.output }],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

function toolCallModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: JSON.stringify({ q: CONTENT.toolArg }),
        },
      ],
      finishReason: { unified: "tool-calls", raw: undefined },
      usage,
      warnings: [],
    }),
  });
}

function failingModel() {
  return new MockLanguageModelV4({
    doGenerate: async () => {
      throw new Error(`model failed: ${CONTENT.error}`);
    },
  });
}
