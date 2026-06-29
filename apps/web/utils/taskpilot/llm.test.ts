import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { callDecider } from "@/utils/taskpilot/llm";

const TestSchema = z.object({
  action: z.literal("IGNORE"),
  reason: z.string(),
});

function makeResponse(body: object, opts: Partial<ResponseInit> = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...opts,
  });
}

describe("callDecider", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_COMPATIBLE_BASE_URL", "https://llm.example");
    vi.stubGlobal("fetch", vi.fn());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("parses a clean structured response", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      makeResponse({
        choices: [
          {
            message: {
              content: JSON.stringify({ action: "IGNORE", reason: "x" }),
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const r = await callDecider({
      model: "m",
      effort: "low",
      maxTokens: 1000,
      timeoutMs: 5000,
      system: "s",
      user: "u",
      schema: TestSchema,
    });
    expect(r.parsed).toEqual({ action: "IGNORE", reason: "x" });
    expect(r.errorMsg).toBeNull();
    expect(r.usage).toEqual({ input: 100, output: 20 });
  });

  it("strips <think> blocks from content before parsing", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      makeResponse({
        choices: [
          {
            message: {
              content:
                '<think>let me think about this</think>{"action":"IGNORE","reason":"y"}',
            },
          },
        ],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    );
    const r = await callDecider({
      model: "m",
      effort: "low",
      maxTokens: 1000,
      timeoutMs: 5000,
      system: "s",
      user: "u",
      schema: TestSchema,
    });
    expect(r.parsed).toEqual({ action: "IGNORE", reason: "y" });
  });

  it("retries once with validation error appended on schema failure", async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        makeResponse({
          choices: [{ message: { content: '{"action":"WRONG"}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          choices: [
            { message: { content: '{"action":"IGNORE","reason":"ok"}' } },
          ],
          usage: { prompt_tokens: 200, completion_tokens: 20 },
        }),
      );

    const r = await callDecider({
      model: "m",
      effort: "low",
      maxTokens: 1000,
      timeoutMs: 5000,
      system: "s",
      user: "u",
      schema: TestSchema,
    });
    expect(r.parsed).toEqual({ action: "IGNORE", reason: "ok" });
    expect((globalThis.fetch as any).mock.calls.length).toBe(2);
    const secondBody = JSON.parse(
      (globalThis.fetch as any).mock.calls[1][1].body,
    );
    expect(JSON.stringify(secondBody.messages)).toMatch(/failed validation/i);
  });

  it("returns parsed=null + errorMsg after second schema failure", async () => {
    (globalThis.fetch as any)
      .mockResolvedValueOnce(
        makeResponse({
          choices: [{ message: { content: '{"wrong":true}' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10 },
        }),
      )
      .mockResolvedValueOnce(
        makeResponse({
          choices: [{ message: { content: "still wrong" } }],
          usage: { prompt_tokens: 200, completion_tokens: 5 },
        }),
      );

    const r = await callDecider({
      model: "m",
      effort: "low",
      maxTokens: 1000,
      timeoutMs: 5000,
      system: "s",
      user: "u",
      schema: TestSchema,
    });
    expect(r.parsed).toBeNull();
    expect(r.errorMsg).toMatch(/schema/i);
  });

  it("returns parsed=null + errorMsg on HTTP error", async () => {
    (globalThis.fetch as any).mockResolvedValueOnce(
      new Response("nope", { status: 500 }),
    );
    const r = await callDecider({
      model: "m",
      effort: "low",
      maxTokens: 1000,
      timeoutMs: 5000,
      system: "s",
      user: "u",
      schema: TestSchema,
    });
    expect(r.parsed).toBeNull();
    expect(r.errorMsg).toMatch(/500/);
  });
});
