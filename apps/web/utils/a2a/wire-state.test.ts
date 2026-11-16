import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { A2aTaskState } from "@/generated/prisma/enums";
import { fromWireState, toWireState } from "./wire-state";

describe("wire state", () => {
  /**
   * We emitted v0.3 names to a peer that advertises protocolVersion "1.0".
   * Two v1.0 agents, and we were the non-conformant one.
   */
  it("emits the v1.0 spelling", () => {
    expect(toWireState(A2aTaskState.auth_required)).toBe(
      "TASK_STATE_AUTH_REQUIRED",
    );
    expect(toWireState(A2aTaskState.working)).toBe("TASK_STATE_WORKING");
    expect(toWireState(A2aTaskState.completed)).toBe("TASK_STATE_COMPLETED");
  });

  // v1.0 removed `unknown`; TASK_STATE_UNSPECIFIED took its place.
  it("maps the state v1.0 dropped onto its replacement", () => {
    expect(toWireState(A2aTaskState.unknown)).toBe("TASK_STATE_UNSPECIFIED");
  });

  it("gives every stored state a wire name", () => {
    for (const state of Object.values(A2aTaskState)) {
      expect(toWireState(state)).toMatch(/^TASK_STATE_[A-Z_]+$/);
    }
  });

  /**
   * Inbound accepts both, so a peer written against either version keeps
   * working and nothing had to be coordinated to land this.
   */
  it("accepts either spelling on the way in", () => {
    expect(fromWireState("TASK_STATE_AUTH_REQUIRED")).toBe(
      A2aTaskState.auth_required,
    );
    expect(fromWireState("auth_required")).toBe(A2aTaskState.auth_required);
    expect(fromWireState("  TASK_STATE_WORKING  ")).toBe(A2aTaskState.working);
  });

  it("round-trips every state", () => {
    for (const state of Object.values(A2aTaskState)) {
      expect(fromWireState(toWireState(state))).toBe(state);
    }
  });

  // A filter that isn't a state must fail loudly, not match nothing.
  it("refuses a name it does not know", () => {
    expect(fromWireState("TASK_STATE_BANANA")).toBeNull();
    expect(fromWireState("")).toBeNull();
  });
});
