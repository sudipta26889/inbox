import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateA2aRequest } from "@/utils/a2a/auth";
import {
  checkA2aRequestRateLimit,
  checkIpRateLimit,
} from "@/utils/a2a/rate-limit";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({ default: {} }));
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/a2a/auth", () => ({
  authenticateA2aRequest: vi.fn(),
  createUnauthorizedResponse: vi.fn(() => ({
    status: 401,
    headers: {},
    body: { error: "unauthorized" },
  })),
}));
vi.mock("@/utils/a2a/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/a2a/rate-limit")>()),
  checkIpRateLimit: vi.fn(),
  checkA2aRequestRateLimit: vi.fn(),
}));
const { mockHandleTaskGet } = vi.hoisted(() => ({
  mockHandleTaskGet: vi.fn(),
}));
vi.mock("@/utils/a2a/protocol-handler", () => ({
  handleTaskGet: mockHandleTaskGet,
}));
vi.mock("@/utils/a2a/push-config", () => ({}));

const context = { params: Promise.resolve({}) };
const allowed = {
  allowed: true,
  limit: 20,
  remaining: 19,
  resetAt: new Date(),
};
const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
});

describe("POST /a2a", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticateA2aRequest).mockResolvedValue(null as never);
    vi.mocked(checkIpRateLimit).mockResolvedValue(allowed as never);
  });

  it("applies the IP limit before reading the body", async () => {
    vi.mocked(checkIpRateLimit).mockResolvedValue({
      ...allowed,
      allowed: false,
      remaining: 0,
      retryAfter: 30,
    } as never);
    const request = post(initialize);

    const response = await POST(request, context);

    expect(response.status).toBe(429);
    expect(request.bodyUsed).toBe(false);
    expect(await response.json()).toMatchObject({
      id: null,
      error: { code: -32_003 },
    });
  });

  it("returns 413 without credentials over 16 KB", async () => {
    const response = await POST(post("x".repeat(16 * 1024 + 1)), context);

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect((await response.json()).error.code).toBe(-32_600);
  });

  it("accepts a larger body with credentials", async () => {
    vi.mocked(authenticateA2aRequest).mockResolvedValue({} as never);
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { padding: "x".repeat(1024 * 1024) },
    });

    const response = await POST(
      post(body, { Authorization: "Bearer good-token" }),
      context,
    );

    expect(response.status).toBe(200);
  });

  it("returns 413 with credentials over the full limit", async () => {
    vi.mocked(authenticateA2aRequest).mockResolvedValue({} as never);

    const response = await POST(
      post("x".repeat(40 * 1024 * 1024), {
        Authorization: "Bearer good-token",
      }),
      context,
    );

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
  });

  it.each([
    [
      "a database error",
      Object.assign(new TypeError("relation a2a_tasks: column x"), {
        clientVersion: "7",
      }),
      "Handler error: Internal error",
    ],
    [
      "a handler's own message",
      new Error("Task not found: t1"),
      "Handler error: Task not found: t1",
    ],
  ])("tells the peer only what is meant for it on %s", async (_label, error, message) => {
    vi.mocked(authenticateA2aRequest).mockResolvedValue({
      userId: "u",
      clientId: "c",
    } as never);
    vi.mocked(checkA2aRequestRateLimit).mockResolvedValue(allowed as never);
    mockHandleTaskGet.mockRejectedValue(error);

    const response = await POST(
      post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tasks/get",
          params: { taskId: "t1" },
        }),
        { Authorization: "Bearer good-token" },
      ),
      context,
    );

    expect((await response.json()).error.message).toBe(message);
  });

  it("returns a JSON-RPC parse error for invalid JSON", async () => {
    const response = await POST(post("{nope"), context);

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe(-32_700);
  });

  it("still answers initialize without credentials", async () => {
    const response = await POST(post(initialize), context);

    expect(response.status).toBe(200);
    expect((await response.json()).result.protocolVersion).toBe("0.3");
  });

  it("uses the same IP bucket whatever the first X-Forwarded-For entry is", async () => {
    await POST(
      post(initialize, {
        "X-Forwarded-For": "1.1.1.1, 9.9.9.9",
        "X-Real-IP": "9.9.9.9",
      }),
      context,
    );
    await POST(
      post(initialize, {
        "X-Forwarded-For": "2.2.2.2, 9.9.9.9",
        "X-Real-IP": "9.9.9.9",
      }),
      context,
    );

    expect(vi.mocked(checkIpRateLimit).mock.calls).toEqual([
      ["9.9.9.9"],
      ["9.9.9.9"],
    ]);
  });
});

function post(body: string, headers?: Record<string, string>) {
  return new NextRequest("http://localhost/a2a", {
    method: "POST",
    body,
    headers,
  });
}
