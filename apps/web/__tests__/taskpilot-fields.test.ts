// ponytail: tuned for kimi-k2.6 @ low effort; retune if model changes.
import { describe, expect, it } from "vitest";
import { decidePass2 } from "@/utils/taskpilot/decide";
import type { RichCandidate } from "@/utils/taskpilot/types";

// Hits a live model. Run with `pnpm test-ai`.
const isAiTest = process.env.RUN_AI_TESTS === "true";

const MODEL = process.env.TASKPILOT_FIELDS_MODEL ?? "kimi-k2.6";

function target(): RichCandidate {
  return {
    projectId: "proj-1",
    taskpilotIssueId: "iss-1",
    taskpilotIdentifier: "X-1",
    workspaceSlug: "ws",
    score: 0.9,
    detail: {
      id: "iss-1",
      identifier: "X-1",
      name: "task",
      description_html: "",
      state: { id: "s", name: "n", group: "started" },
      priority: "medium",
      assignees: [],
      labels: [],
    },
    recentComments: [],
  };
}

describe.runIf(isAiTest)("Pass 2 — field updates", () => {
  it("'this is now urgent' → priority urgent", async () => {
    const r = await decidePass2({
      email: {
        from: "x",
        subject: "s",
        bodyText: "This is now urgent — drop everything.",
      },
      executedTargets: [target()],
      projectLabels: { "proj-1": ["billing"] },
      workspaceMembers: [],
      todayISO: "2026-06-29",
      model: MODEL,
      effort: "low",
      maxTokens: 4000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const u = r.updates.updates.find((u) => u.targetIssueId === "iss-1");
      expect(u?.priority).toBe("urgent");
    }
  });

  it("'complete by 2026-07-15' → targetDate set", async () => {
    const r = await decidePass2({
      email: {
        from: "x",
        subject: "s",
        bodyText: "Please complete by 2026-07-15.",
      },
      executedTargets: [target()],
      projectLabels: { "proj-1": [] },
      workspaceMembers: [],
      todayISO: "2026-06-29",
      model: MODEL,
      effort: "low",
      maxTokens: 4000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const u = r.updates.updates.find((u) => u.targetIssueId === "iss-1");
      expect(u?.targetDate).toBe("2026-07-15");
    }
  });

  it("no concrete signals → empty updates", async () => {
    const r = await decidePass2({
      email: { from: "x", subject: "s", bodyText: "Thanks for the update." },
      executedTargets: [target()],
      projectLabels: { "proj-1": [] },
      workspaceMembers: [],
      todayISO: "2026-06-29",
      model: MODEL,
      effort: "low",
      maxTokens: 4000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.updates.updates.length).toBe(0);
  });
});
