import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_BASE_URL: "https://inbox.test" },
}));

import { GET } from "@/app/.well-known/agent-card.json/route";
import { peerDeniedSkills } from "@/utils/a2a/peer-tool-policy";
import { A2A_SKILL_REGISTRY } from "@/utils/a2a/skill-registry";

async function card() {
  const response = await GET();
  return (await response.json()) as {
    url?: string;
    supportedInterfaces?: {
      url: string;
      protocolBinding: string;
      protocolVersion: string;
    }[];
    skills: { name: string; requiresHumanApproval?: boolean }[];
  };
}

describe("published agent card", () => {
  /**
   * The card is what a peer plans against. Advertising a skill that
   * peer-tool-policy refuses for every peer is a promise we always break —
   * email.send was listed and denied at the same time.
   */
  it("advertises nothing a peer would be refused", async () => {
    const names = (await card()).skills.map((skill) => skill.name);

    for (const denied of peerDeniedSkills()) {
      expect(names).not.toContain(denied);
    }
  });

  /**
   * `requiresHumanApproval` on the card and `requiresApproval` in the registry
   * are the same fact. Hand-copied, they drift, and the direction that hurts is
   * a card saying "no approval needed" for a skill that parks — a peer then
   * treats a parked task as a failure.
   */
  it("takes the approval flag from the registry, not a second copy", async () => {
    for (const skill of (await card()).skills) {
      expect(
        Boolean(skill.requiresHumanApproval),
        `card and registry disagree about ${skill.name}`,
      ).toBe(Boolean(A2A_SKILL_REGISTRY[skill.name]?.requiresApproval));
    }
  });

  it("advertises only skills the registry actually implements", async () => {
    for (const skill of (await card()).skills) {
      expect(
        A2A_SKILL_REGISTRY[skill.name],
        `${skill.name} is not registered`,
      ).toBeDefined();
    }
  });
});

describe("protocol version advertised", () => {
  /**
   * v1.0 replaced the bare `url` with supportedInterfaces[]. Our peer already
   * advertises protocolVersion "1.0" in its own card, so we were the
   * non-conformant side of a conversation between two v1.0 agents.
   */
  it("declares a v1.0 JSON-RPC interface", async () => {
    const interfaces = (await card()).supportedInterfaces;

    expect(interfaces).toEqual([
      expect.objectContaining({
        protocolBinding: "JSONRPC",
        protocolVersion: "1.0",
      }),
    ]);
  });

  // Kept alongside, so a client still reading the v0.3 shape is not stranded.
  it("still carries the legacy url for older clients", async () => {
    const published = await card();

    expect(published.url).toBe(published.supportedInterfaces?.[0]?.url);
  });
});
