import "server-only";
import { A2aTaskState } from "@/generated/prisma/enums";

/**
 * Task state on the wire.
 *
 * Storage keeps the lowercase names — they are a database enum, and the spec
 * governs the protocol, not our schema. But we were also EMITTING them, which
 * is v0.3 vocabulary: A2A v1.0 renamed every state to `TASK_STATE_*` and
 * removed `unknown` in favour of `TASK_STATE_UNSPECIFIED`. Our own peer
 * (OpenClaw) advertises `protocolVersion: "1.0"` in its card, so we were the
 * non-conformant side of a conversation between two v1.0 agents.
 *
 * Inbound accepts both spellings. A peer written against either version keeps
 * working, and nothing has to be coordinated to land this.
 */

const TO_WIRE: Record<A2aTaskState, string> = {
  [A2aTaskState.submitted]: "TASK_STATE_SUBMITTED",
  [A2aTaskState.working]: "TASK_STATE_WORKING",
  [A2aTaskState.input_required]: "TASK_STATE_INPUT_REQUIRED",
  [A2aTaskState.auth_required]: "TASK_STATE_AUTH_REQUIRED",
  [A2aTaskState.completed]: "TASK_STATE_COMPLETED",
  [A2aTaskState.failed]: "TASK_STATE_FAILED",
  [A2aTaskState.canceled]: "TASK_STATE_CANCELED",
  [A2aTaskState.rejected]: "TASK_STATE_REJECTED",
  // v1.0 dropped `unknown`; this is its replacement.
  [A2aTaskState.unknown]: "TASK_STATE_UNSPECIFIED",
};

export function toWireState(state: A2aTaskState): string {
  return TO_WIRE[state] ?? "TASK_STATE_UNSPECIFIED";
}

/** Accepts v1.0 (`TASK_STATE_WORKING`) and v0.3 (`working`) alike. */
export function fromWireState(value: string): A2aTaskState | null {
  const normalized = value.trim();

  if (normalized in A2aTaskState) {
    return A2aTaskState[normalized as keyof typeof A2aTaskState];
  }

  const match = Object.entries(TO_WIRE).find(
    ([, wire]) => wire === normalized.toUpperCase(),
  );

  return match ? (match[0] as A2aTaskState) : null;
}
