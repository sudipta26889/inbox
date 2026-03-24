import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  fetchAgentCard,
  resolveA2aEndpoint,
  sendA2aMessage,
  getRemoteAgentUrls,
  buildA2aEmailPayload,
} from "./a2a-client";

vi.mock("server-only", () => ({}));

vi.mock("@/env", () => ({
  env: {
    A2A_REMOTE_AGENTS: "http://agent1:8080,http://agent2:9090",
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("fetchAgentCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches agent card from well-known URL", async () => {
    const card = { name: "test-agent", version: "1.0" };
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(card),
    });

    const result = await fetchAgentCard("http://agent.local:8080");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://agent.local:8080/.well-known/agent-card.json",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(card);
  });

  it("strips trailing slash from base URL", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ name: "agent" }),
    });

    await fetchAgentCard("http://agent.local:8080/");

    expect(mockFetch).toHaveBeenCalledWith(
      "http://agent.local:8080/.well-known/agent-card.json",
      expect.anything(),
    );
  });

  it("throws on non-OK response", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 404 });

    await expect(fetchAgentCard("http://agent.local")).rejects.toThrow(
      "Failed to fetch agent card",
    );
  });
});

describe("resolveA2aEndpoint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves endpoint from agent card json-rpc binding", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "agent",
          bindings: [{ url: "/rpc", transport: "json-rpc" }],
        }),
    });

    const endpoint = await resolveA2aEndpoint("http://agent.local:8080");
    expect(endpoint).toBe("http://agent.local:8080/rpc");
  });

  it("uses absolute URL from binding when provided", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "agent",
          bindings: [
            { url: "http://other-host:9090/rpc", transport: "json-rpc" },
          ],
        }),
    });

    const endpoint = await resolveA2aEndpoint("http://agent.local:8080");
    expect(endpoint).toBe("http://other-host:9090/rpc");
  });

  it("falls back to /a2a when agent card fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("connection refused"));

    const endpoint = await resolveA2aEndpoint("http://agent.local:8080");
    expect(endpoint).toBe("http://agent.local:8080/a2a");
  });

  it("falls back to /a2a when no json-rpc binding exists", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          name: "agent",
          bindings: [{ url: "/ws", transport: "websocket" }],
        }),
    });

    const endpoint = await resolveA2aEndpoint("http://agent.local:8080");
    expect(endpoint).toBe("http://agent.local:8080/a2a");
  });
});

describe("sendA2aMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sends JSON-RPC message and returns result", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          result: { taskId: "task-123", state: "completed" },
        }),
    });

    const result = await sendA2aMessage("http://agent.local/a2a", {
      content: "hello",
    });

    expect(result).toEqual({ taskId: "task-123", state: "completed" });
    expect(mockFetch).toHaveBeenCalledWith(
      "http://agent.local/a2a",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.method).toBe("message.send");
    expect(body.params.content).toBe("hello");
  });

  it("returns error when agent responds with JSON-RPC error", async () => {
    mockFetch.mockResolvedValue({
      json: () =>
        Promise.resolve({
          error: { code: -32_600, message: "Invalid request" },
        }),
    });

    const result = await sendA2aMessage("http://agent.local/a2a", {
      content: "bad",
    });

    expect(result.error).toEqual({
      code: -32_600,
      message: "Invalid request",
    });
  });

  it("returns error on network failure", async () => {
    mockFetch.mockRejectedValue(new Error("timeout"));

    const result = await sendA2aMessage("http://agent.local/a2a", {
      content: "hello",
    });

    expect(result.error).toEqual({ code: -1, message: "timeout" });
  });

  it("uses provided contextId", async () => {
    mockFetch.mockResolvedValue({
      json: () => Promise.resolve({ result: {} }),
    });

    await sendA2aMessage("http://agent.local/a2a", {
      content: "hello",
      contextId: "my-ctx",
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.params.contextId).toBe("my-ctx");
  });
});

describe("getRemoteAgentUrls", () => {
  it("parses comma-separated agent URLs from env", () => {
    const urls = getRemoteAgentUrls();
    expect(urls).toEqual(["http://agent1:8080", "http://agent2:9090"]);
  });
});

describe("buildA2aEmailPayload", () => {
  it("builds payload with all fields", () => {
    const now = new Date("2026-01-15T10:00:00Z");
    const payload = buildA2aEmailPayload(
      {
        from: "alice@example.com",
        subject: "Important",
        snippet: "Please review",
        threadId: "t-1",
        messageId: "m-1",
        labels: ["INBOX", "IMPORTANT"],
        receivedAt: now,
      },
      { ruleName: "urgent", ruleId: "r-1" },
    );

    expect(payload.content).toBe(
      "Urgent email from alice@example.com: Important",
    );
    expect(payload.input.from).toBe("alice@example.com");
    expect(payload.input.subject).toBe("Important");
    expect(payload.input.snippet).toBe("Please review");
    expect(payload.input.thread_id).toBe("t-1");
    expect(payload.input.message_id).toBe("m-1");
    expect(payload.input.labels).toEqual(["INBOX", "IMPORTANT"]);
    expect(payload.input.received_at).toBe("2026-01-15T10:00:00.000Z");
    expect(payload.input.rule_name).toBe("urgent");
    expect(payload.input.rule_id).toBe("r-1");
    expect(payload.input.timestamp).toBeDefined();
  });

  it("handles missing optional fields", () => {
    const payload = buildA2aEmailPayload(
      {
        from: "bob@example.com",
        subject: "Hi",
        threadId: "t-2",
        messageId: "m-2",
      },
      { ruleId: "r-2" },
    );

    expect(payload.input.snippet).toBeUndefined();
    expect(payload.input.labels).toBeUndefined();
    expect(payload.input.received_at).toBeUndefined();
    expect(payload.input.rule_name).toBeUndefined();
  });
});
