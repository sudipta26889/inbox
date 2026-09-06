import { A2A_SKILL_REGISTRY } from "@/utils/a2a/skill-registry";
import { MCP_TOOLS } from "@/utils/mcp-server/tools/registry";

/**
 * What an external peer may reach.
 *
 * A peer holding a token is not the account owner. One bad write's blast radius
 * is the datastore, not the request — so the decision is made here, once, at
 * the point tools are assembled, rather than trusting each new skill to declare
 * the right scope.
 *
 * The rule is deny-by-default on writes: a tool is peer-reachable only if its
 * required scope is a read scope. A tool added tomorrow with `email:write` is
 * refused without anyone editing this file, which is the property the previous
 * arrangement lacked — `email.send` sat in the registry reachable by any peer
 * that happened to hold a write scope, gated only by the provider layer.
 */

const READ_SCOPES = new Set([
  "email:read",
  "calendar:read",
  "stats:read",
  "rules:read",
]);

/**
 * Writes a peer may request because a human approves each one before it runs.
 *
 * Add a skill here only alongside an approval path the peer cannot bypass.
 * calendar.create_event qualifies: it carries requiresApproval, so the task
 * parks in auth_required and waits for a decision.
 *
 * email.send deliberately does NOT qualify. Its only gate is the provider-layer
 * DharaHIL check, which is a backstop for every caller rather than a
 * peer-facing approval — and sending mail as the owner is a larger trust grant
 * than putting a proposed event in front of them.
 */
const APPROVED_WRITE_SKILLS = new Set<string>(["calendar.create_event"]);

export function isPeerReachableSkill(skill: string): boolean {
  const definition = A2A_SKILL_REGISTRY[skill];

  if (!definition) return false;
  if (APPROVED_WRITE_SKILLS.has(skill)) return true;

  return READ_SCOPES.has(definition.requiredScope);
}

/** Every skill a peer may invoke, for the agent card and for tests. */
export function peerReachableSkills(): string[] {
  return Object.keys(A2A_SKILL_REGISTRY).filter(isPeerReachableSkill);
}

/**
 * Skills registered but not peer-reachable. Exposed so a test can assert the
 * set is what we think it is, rather than silently growing.
 */
export function peerDeniedSkills(): string[] {
  return Object.keys(A2A_SKILL_REGISTRY).filter(
    (skill) => !isPeerReachableSkill(skill),
  );
}

/**
 * MCP tools that write, derived from their declared scope rather than a
 * hand-kept list, so a new write tool is classified on the day it lands.
 */
export function writeToolNames(): string[] {
  return Object.entries(MCP_TOOLS)
    .filter(([, tool]) => !READ_SCOPES.has(tool.requiredScope))
    .map(([name]) => name)
    .sort();
}
