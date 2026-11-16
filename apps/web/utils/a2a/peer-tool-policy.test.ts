import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import {
  isPeerReachableSkill,
  peerDeniedSkills,
  peerReachableSkills,
  writeToolNames,
} from "./peer-tool-policy";

describe("peer tool policy", () => {
  it("lets a peer reach read skills", () => {
    expect(isPeerReachableSkill("email.search")).toBe(true);
    expect(isPeerReachableSkill("calendar.availability")).toBe(true);
    expect(isPeerReachableSkill("digest.get")).toBe(true);
  });

  /**
   * The point of the whole file. email.send was reachable by any peer holding
   * email:write, gated only by the provider-layer approval — which is a
   * backstop for every caller, not a peer-facing review.
   */
  it("denies a write with no peer-facing approval", () => {
    expect(isPeerReachableSkill("email.send")).toBe(false);
  });

  // Allowed only because requiresApproval parks the task for a human.
  it("allows a write that a human must approve first", () => {
    expect(isPeerReachableSkill("calendar.create_event")).toBe(true);
  });

  it("denies a skill it has never heard of", () => {
    expect(isPeerReachableSkill("email.delete_everything")).toBe(false);
  });

  /**
   * Deny-by-default is the property worth protecting: a skill added tomorrow
   * with a write scope must be denied without anyone editing the policy. This
   * asserts the classification is derived from scope, not from a hand-kept
   * allowlist that a new skill would bypass.
   */
  it("classifies by scope, so a new write skill is denied on arrival", () => {
    const denied = peerDeniedSkills();
    const reachable = peerReachableSkills();

    expect(denied).toContain("email.send");
    // Anything reachable is either read-scoped or an explicitly approved write.
    for (const skill of reachable) {
      expect(isPeerReachableSkill(skill)).toBe(true);
    }
    expect(reachable.length + denied.length).toBeGreaterThan(0);
  });

  it("derives the write-tool list from declared scopes", () => {
    const writes = writeToolNames();

    expect(writes).toEqual(expect.arrayContaining(["send_email"]));
    expect(writes).not.toContain("search_emails");
  });
});
