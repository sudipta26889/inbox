import { describe, expect, it, vi } from "vitest";
import { decidePass1, decidePass2 } from "@/utils/taskpilot/decide";

vi.mock("@/utils/taskpilot/llm-call", () => ({
  callDecider: vi.fn(),
}));
import { callDecider } from "@/utils/taskpilot/llm-call";

describe("decidePass1", () => {
  it("returns ok with decision on success", async () => {
    (callDecider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      parsed: { action: "IGNORE", reason: "auto-reply" },
      raw: "",
      usage: { input: 100, output: 5 },
      durationMs: 200,
      errorMsg: null,
    });
    const r = await decidePass1({
      mode: "auto",
      email: { from: "x", subject: "s", bodyText: "b", receivedAt: new Date() },
      candidates: [],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: "2026-06-29",
      model: "m",
      effort: "low",
      maxTokens: 100,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.action).toBe("IGNORE");
  });

  it("returns ok:false with errorMsg on LLM failure", async () => {
    (callDecider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      parsed: null,
      raw: "",
      usage: null,
      durationMs: 0,
      errorMsg: "LLM timeout",
    });
    const r = await decidePass1({
      mode: "auto",
      email: { from: "x", subject: "s", bodyText: "b", receivedAt: new Date() },
      candidates: [],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: "2026-06-29",
      model: "m",
      effort: "low",
      maxTokens: 100,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errorMsg).toMatch(/timeout/i);
  });
});

describe("decidePass2", () => {
  it("returns ok with parsed updates", async () => {
    (callDecider as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      parsed: { updates: [], reason: "nothing concrete" },
      raw: "",
      usage: { input: 50, output: 10 },
      durationMs: 100,
      errorMsg: null,
    });
    const r = await decidePass2({
      email: { from: "x", subject: "s", bodyText: "b" },
      executedTargets: [],
      projectLabels: {},
      workspaceMembers: [],
      todayISO: "2026-06-29",
      model: "m",
      effort: "low",
      maxTokens: 100,
      timeoutMs: 1000,
    });
    expect(r.ok).toBe(true);
  });
});
