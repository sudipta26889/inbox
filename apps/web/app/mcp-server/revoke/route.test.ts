import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { revokeAccessToken } from "@/utils/mcp-server/tokens";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/mcp-server/tokens", () => ({
  revokeAccessToken: vi.fn(),
}));

describe("POST /mcp-server/revoke", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 413 over 16 KB without revoking", async () => {
    const response = await POST(post(`token=${"x".repeat(16 * 1024)}`));

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect(revokeAccessToken).not.toHaveBeenCalled();
  });

  it("still revokes a token sent in a form under the limit", async () => {
    const response = await POST(post("token=abc"));

    expect(response.status).toBe(200);
    expect(vi.mocked(revokeAccessToken).mock.calls[0][0]).toBe("abc");
  });
});

function post(body: string) {
  return new NextRequest("http://localhost/mcp-server/revoke", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
