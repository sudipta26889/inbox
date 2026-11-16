import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    LONGMEMORY_BASE_URL: "http://memory.local/mcp",
    LONGMEMORY_API_KEY: "test-key",
  },
}));

import { createScopedLogger } from "@/utils/logger";
import { ingestMemory, recallMemories, recallMemoriesOrNone } from "./client";

const logger = createScopedLogger("longmemory-test");

/** The server answers over SSE framing, so tests must speak it too. */
function sse(result: unknown): Response {
  const body = `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result })}\n\n`;
  return new Response(body, { status: 200 });
}

function toolResult(payload: unknown, isError = false): Response {
  return sse({
    isError,
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
}

function recallItem(raw: string, status = "active", score = 0.5) {
  return { score, node: { content: { raw }, state: { status } } };
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

describe("long memory client", () => {
  it("parses recalled memories out of the SSE envelope", async () => {
    fetchMock.mockResolvedValue(
      toolResult({
        items: [recallItem("prefers digests at 5am", "active", 0.9)],
      }),
    );

    await expect(
      recallMemories({ emailAccountId: "acct-1", query: "digest time" }),
    ).resolves.toEqual([{ content: "prefers digests at 5am", score: 0.9 }]);
  });

  /**
   * The point of the whole file.
   *
   * A permission denial comes back as HTTP 200 with a well-formed JSON-RPC
   * result carrying isError. Read carelessly it is indistinguishable from an
   * empty store, and the agent then tells the user it knows nothing about them
   * — which is what a fail-soft `return []` here would produce.
   */
  it("throws on an error delivered inside a successful result", async () => {
    fetchMock.mockResolvedValue(
      sse({
        isError: true,
        content: [{ type: "text", text: "permission denied for user: nobody" }],
      }),
    );

    await expect(
      recallMemories({ emailAccountId: "acct-1", query: "anything" }),
    ).rejects.toThrow(/permission denied/);
  });

  it("does not send user_id, which is what triggers that denial", async () => {
    fetchMock.mockResolvedValue(toolResult({ items: [] }));

    await recallMemories({ emailAccountId: "acct-1", query: "q" });

    const args = JSON.parse(fetchMock.mock.calls[0][1].body).params.arguments;
    expect(args).not.toHaveProperty("user_id");
  });

  /** Isolation between the accounts on this instance rests on this string. */
  it("scopes every call to the account's own project", async () => {
    fetchMock.mockResolvedValue(toolResult({ items: [] }));

    await recallMemories({ emailAccountId: "acct-A", query: "q" });
    await ingestMemory({
      emailAccountId: "acct-B",
      text: "t",
      source: "s",
      logger,
    });

    const projects = fetchMock.mock.calls.map(
      (call) => JSON.parse(call[1].body).params.arguments.project_id,
    );
    expect(projects).toEqual(["inbox-acct-A", "inbox-acct-B"]);
  });

  it("drops memories the server has superseded", async () => {
    fetchMock.mockResolvedValue(
      toolResult({
        items: [
          recallItem("digest at 5am", "active"),
          recallItem("digest at 7am", "superseded"),
        ],
      }),
    );

    const memories = await recallMemories({
      emailAccountId: "acct-1",
      query: "digest",
    });

    expect(memories.map((m) => m.content)).toEqual(["digest at 5am"]);
  });

  it("surfaces a transport failure rather than reporting an empty store", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));

    await expect(
      recallMemories({ emailAccountId: "acct-1", query: "q" }),
    ).rejects.toThrow(/502/);
  });

  // Background grounding opts into silence; the search tool must not.
  it("returns nothing, without throwing, on the opt-in soft path", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 502 }));

    await expect(
      recallMemoriesOrNone({ emailAccountId: "acct-1", query: "q", logger }),
    ).resolves.toEqual([]);
  });

  it("returns the stored id on ingest", async () => {
    fetchMock.mockResolvedValue(
      toolResult({ memory_id: "project:inbox-acct-1:manual_fact:abc" }),
    );

    await expect(
      ingestMemory({
        emailAccountId: "acct-1",
        text: "remember this",
        source: "inbox-zero-chat",
        logger,
      }),
    ).resolves.toBe("project:inbox-acct-1:manual_fact:abc");
  });
});
