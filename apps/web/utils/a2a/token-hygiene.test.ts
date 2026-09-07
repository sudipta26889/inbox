import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: { mcpServerAccessToken: { findMany: vi.fn() } },
}));
vi.mock("@/utils/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK") },
}));

import { reportA2aTokenHygiene } from "./token-hygiene";

const prisma = await import("@/utils/prisma").then((m) => m.default);
const findMany = prisma.mcpServerAccessToken.findMany as ReturnType<
  typeof vi.fn
>;

const logger = createScopedLogger("token-hygiene-test");
const DAY = 24 * 60 * 60 * 1000;

function token(overrides: Record<string, unknown> = {}) {
  return {
    clientId: "a2a_peer",
    createdAt: new Date(Date.now() - 200 * DAY),
    expiresAt: new Date(Date.now() + 3000 * DAY),
    lastUsedAt: new Date(),
    client: { clientName: "Peer", type: "A2A" },
    ...overrides,
  };
}

describe("reportA2aTokenHygiene", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("says nothing about a healthy long-lived token", async () => {
    findMany.mockResolvedValue([token()]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings).toEqual([]);
  });

  it("ignores tokens belonging to non-A2A clients", async () => {
    findMany.mockResolvedValue([
      token({ client: { clientName: "MCP", type: "MCP" }, lastUsedAt: null }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.checked).toBe(0);
  });

  it("flags a token nearing expiry", async () => {
    findMany.mockResolvedValue([
      token({ expiresAt: new Date(Date.now() + 10 * DAY) }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "expiring" });
  });

  // The failure mode that actually bit: a peer stops calling and the dead
  // credential stays valid, unnoticed, for years.
  it("flags a credential the peer stopped using", async () => {
    findMany.mockResolvedValue([
      token({ lastUsedAt: new Date(Date.now() - 90 * DAY) }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "stale" });
    expect(result.findings[0].detail).toContain("90d");
  });

  it("does not call a freshly minted token stale", async () => {
    findMany.mockResolvedValue([
      token({ createdAt: new Date(Date.now() - 2 * DAY), lastUsedAt: null }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings).toEqual([]);
  });

  it("flags a token that expired 100 days ago as expired, not expiring", async () => {
    findMany.mockResolvedValue([
      token({ expiresAt: new Date(Date.now() - 100 * DAY) }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "expired" });
    expect(result.findings[0].detail).toContain("100d ago");
    // Verify the detail does not include a negative number (expires in -XXd pattern)
    expect(result.findings[0].detail).not.toMatch(/expires in -/);
  });

  it("reports the boundary: 0 days to expiry is expiring, not expired", async () => {
    const expiresAt = new Date(Date.now()); // Expires now (0 days)
    findMany.mockResolvedValue([token({ expiresAt })]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "expiring" });
    expect(result.findings[0].detail).toContain("expires in 0d");
  });

  it("reports expiring token with future tense", async () => {
    findMany.mockResolvedValue([
      token({ expiresAt: new Date(Date.now() + 10 * DAY) }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "expiring" });
    expect(result.findings[0].detail).toContain("expires in 10d");
  });

  it("keeps stale detection unchanged", async () => {
    findMany.mockResolvedValue([
      token({ lastUsedAt: new Date(Date.now() - 90 * DAY) }),
    ]);

    const result = await reportA2aTokenHygiene(logger);

    expect(result.findings[0]).toMatchObject({ reason: "stale" });
    expect(result.findings[0].detail).toContain("90d");
  });
});
