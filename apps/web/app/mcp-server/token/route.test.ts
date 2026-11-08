import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/prisma";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: { mcpServerClient: { findUnique: vi.fn() } },
}));

describe("POST /mcp-server/token", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(prisma.mcpServerClient.findUnique).mockResolvedValue(null);
  });

  it("returns 413 over 16 KB without looking up a client", async () => {
    const response = await POST(post(`grant_type=${"x".repeat(16 * 1024)}`));

    expect(response.status).toBe(413);
    expect(response.headers.get("connection")).toBe("close");
    expect((await response.json()).error).toBe("invalid_request");
    expect(prisma.mcpServerClient.findUnique).not.toHaveBeenCalled();
  });

  it("still parses a urlencoded form under the limit", async () => {
    const response = await POST(post("grant_type=refresh_token&client_id=abc"));

    expect((await response.json()).error).toBe("invalid_client");
    expect(prisma.mcpServerClient.findUnique).toHaveBeenCalledWith({
      where: { clientId: "abc" },
    });
  });
});

function post(body: string) {
  return new NextRequest("http://localhost/mcp-server/token", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
}
