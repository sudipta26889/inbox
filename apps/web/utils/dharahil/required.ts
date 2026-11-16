import "server-only";
import { env } from "@/env";

/**
 * Is the human approval gate mandatory for this deployment?
 *
 * Derived from server-side configuration, deliberately NOT from
 * NEXT_PUBLIC_DHARAHIL_ENABLED. That flag is client-visible UI state, and
 * keying enforcement on it meant every send and every calendar write failed
 * OPEN: set it to false — or typo it in .env — and the action proceeds
 * unapproved, with no error, no log, and no way to tell from the outside that
 * the gate was skipped.
 *
 * A deployment that has configured a gateway has opted into the gate. The only
 * way out is to remove the credentials, which is a deliberate act rather than a
 * one-character mistake. Deployments that never configured DharaHIL (upstream,
 * and any self-host that doesn't run it) are unaffected: no credentials, no
 * gate, same behaviour as before.
 */
export function isApprovalGateRequired(): boolean {
  const status = approvalGateStatus();
  // Production must never send ungated because a key fell out of the stack
  // Env: refuse instead of skipping, and say so on /api/health.
  if (status === "misconfigured")
    throw new Error(
      "The approval gateway is not configured in production, so nothing can be sent.",
    );
  return status === "on";
}

export function approvalGateStatus(): "on" | "off" | "misconfigured" {
  if (env.DHARAHIL_BASE_URL && env.DHARAHIL_API_KEY) return "on";
  return env.NODE_ENV === "production" ? "misconfigured" : "off";
}
