import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({ lookupMock: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: lookupMock }));
vi.mock("@/env", () => ({
  env: {
    A2A_REMOTE_AGENTS: "http://dharabot.lan:12345, http://mitra.lan:8080/a2a",
  },
}));

import { isAllowedA2aDestination } from "./safe-destination";

// What each hostname resolves to, as the real resolver would answer.
const DNS: Record<string, { address: string; family: 4 | 6 }[]> = {
  "localtest.me": [{ address: "127.0.0.1", family: 4 }],
  "public-but-internal.example": [{ address: "10.1.2.3", family: 4 }],
  "mapped.example": [{ address: "::ffff:7f00:1", family: 6 }],
  "peer.example": [{ address: "93.184.216.34", family: 4 }],
  "db.lan": [{ address: "192.168.10.5", family: 4 }],
};

beforeEach(() => {
  lookupMock.mockImplementation(async (hostname: string) => {
    const answer = DNS[hostname];
    if (!answer) throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    return answer;
  });
});

describe("isAllowedA2aDestination", () => {
  it.each([
    ["a homelab .lan name", "https://db.lan/hook"],
    ["a .lan name with a port", "https://nuc.lan:4726/api/v1/pkm/ingest/inbox"],
    ["a public name resolving to loopback", "https://localtest.me/hook"],
    ["an IPv4-mapped IPv6 loopback literal", "https://[::ffff:7f00:1]/hook"],
    ["a name resolving to IPv4-mapped loopback", "https://mapped.example/x"],
    ["a public name resolving to 10.x", "https://public-but-internal.example/"],
    ["localhost", "https://localhost/hook"],
    ["a .local name", "https://printer.local/hook"],
    ["a single-label name", "https://web/hook"],
    ["a private IPv4 literal", "https://192.168.10.252/hook"],
    ["plain http", "http://peer.example/hook"],
    ["a name that does not resolve", "https://nope.example/hook"],
  ])("refuses %s", async (_label, url) => {
    expect(await isAllowedA2aDestination(url)).toBe(false);
  });

  it("allows the configured agent's exact LAN http origin", async () => {
    expect(
      await isAllowedA2aDestination("http://dharabot.lan:12345/a2a/push"),
    ).toBe(true);
  });

  it.each([
    ["another port on the agent's host", "http://dharabot.lan:12346/x"],
    ["the agent's host over https", "https://dharabot.lan:12345/x"],
    ["another LAN host", "http://db.lan:12345/x"],
  ])("refuses %s", async (_label, url) => {
    expect(await isAllowedA2aDestination(url)).toBe(false);
  });

  it.each([
    ["the base path itself", "http://mitra.lan:8080/a2a"],
    ["a path under the base", "http://mitra.lan:8080/a2a/push/task-1"],
  ])("allows the configured agent at %s", async (_label, url) => {
    expect(await isAllowedA2aDestination(url)).toBe(true);
  });

  it.each([
    ["another app on the agent's origin", "http://mitra.lan:8080/admin/hook"],
    ["a sibling path sharing the prefix", "http://mitra.lan:8080/a2a-admin"],
    ["a dot-segment escape", "http://mitra.lan:8080/a2a/../admin"],
    ["an encoded dot-segment escape", "http://mitra.lan:8080/a2a/%2e%2e/admin"],
  ])("refuses %s", async (_label, url) => {
    expect(await isAllowedA2aDestination(url)).toBe(false);
  });

  it("allows a public https host", async () => {
    expect(await isAllowedA2aDestination("https://peer.example/hook")).toBe(
      true,
    );
  });
});
