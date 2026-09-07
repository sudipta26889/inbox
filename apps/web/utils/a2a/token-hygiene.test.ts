import { beforeEach, describe, expect, it, vi } from "vitest";
import { createScopedLogger } from "@/utils/logger";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma", () => ({
  default: { mcpServerAccessToken: { findMany: vi.fn(), deleteMany: vi.fn() } },
}));
vi.mock("@/utils/redis", () => ({
  redis: { set: vi.fn().mockResolvedValue("OK") },
}));

import {
  cleanupExpiredAccessTokens,
  reportA2aTokenHygiene,
} from "./token-hygiene";

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
});

describe("cleanupExpiredAccessTokens", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes tokens that expired longer ago than the grace period", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 54 });
    prisma.mcpServerAccessToken.deleteMany = deleteMany;

    const deleted = await cleanupExpiredAccessTokens(30);

    expect(deleted).toBe(54);
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.expiresAt.lt).toBeInstanceOf(Date);
    // 30 days ago, not now: a token that expired an hour ago may still be
    // mid-refresh on the peer's side.
    const ageDays =
      (Date.now() - where.expiresAt.lt.getTime()) / (24 * 60 * 60 * 1000);
    expect(ageDays).toBeGreaterThan(29);
    expect(ageDays).toBeLessThan(31);
  });

  it("never deletes a token that is still valid", async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    prisma.mcpServerAccessToken.deleteMany = deleteMany;

    await cleanupExpiredAccessTokens(30);

    // The negative control: the filter is on expiresAt in the PAST. If someone
    // flips this to `gt`, or drops the clause, this catches it.
    const where = deleteMany.mock.calls[0][0].where;
    expect(where.expiresAt.lt.getTime()).toBeLessThan(Date.now());
    expect(where).not.toHaveProperty("revoked");
  });
});
