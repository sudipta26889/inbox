// ponytail: tuned for kimi-k2.6 @ medium effort; retune if model changes.
import { describe, expect, it } from "vitest";
import { decidePass1 } from "@/utils/taskpilot/decide";
import type { RichCandidate } from "@/utils/taskpilot/types";

const MODEL = process.env.TASKPILOT_DECIDER_MODEL ?? "kimi-k2.6";

function bpclCandidate(
  state: "started" | "completed" = "started",
): RichCandidate {
  return {
    projectId: "proj-1",
    taskpilotIssueId: "iss-bpcl",
    taskpilotIdentifier: "INBOXEMAIL-12",
    workspaceSlug: "ws",
    score: 0.78,
    detail: {
      id: "iss-bpcl",
      identifier: "INBOXEMAIL-12",
      name: "Resolve BPCL invoice mismatch (ref 11915128)",
      description_html: "<p>Distributor sent the wrong invoice figure.</p>",
      state: {
        id: "s1",
        name: state === "started" ? "In Progress" : "Done",
        group: state,
      },
      priority: "high",
      assignees: [],
      labels: [{ id: "l1", name: "billing" }],
    },
    recentComments: [],
  };
}

describe("Pass 1 — decide", () => {
  it("RESOLVED language → COMMENT_ON + stateGroup=completed + HIGH confidence", async () => {
    const r = await decidePass1({
      mode: "auto",
      email: {
        from: "vendor@bpcl",
        subject: "Re: invoice 11915128",
        bodyText:
          "Issue resolved by the distributor. Updated invoice attached.",
        receivedAt: new Date(),
      },
      candidates: [bpclCandidate("started")],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: new Date().toISOString().slice(0, 10),
      model: MODEL,
      effort: "medium",
      maxTokens: 8000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.decision.action === "COMMENT_ON") {
      expect(r.decision.stateGroup).toBe("completed");
      expect(r.decision.stateConfidence).toBe("HIGH");
      expect(r.decision.targetIssueIds).toContain("iss-bpcl");
    } else {
      expect.fail(
        `expected COMMENT_ON, got ${r.ok ? r.decision.action : r.errorMsg}`,
      );
    }
  });

  it("OOO auto-reply → IGNORE", async () => {
    const r = await decidePass1({
      mode: "auto",
      email: {
        from: "vendor@bpcl",
        subject: "Out of office",
        bodyText: "I am out of office until Monday. Will reply when I return.",
        receivedAt: new Date(),
      },
      candidates: [bpclCandidate("started")],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: new Date().toISOString().slice(0, 10),
      model: MODEL,
      effort: "medium",
      maxTokens: 8000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.action).toBe("IGNORE");
  });

  it("Re-open language on a completed candidate → stateGroup=started", async () => {
    const r = await decidePass1({
      mode: "auto",
      email: {
        from: "customer@x",
        subject: "Re: BPCL invoice",
        bodyText:
          "This is still broken — the new invoice has the same wrong figure.",
        receivedAt: new Date(),
      },
      candidates: [bpclCandidate("completed")],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: new Date().toISOString().slice(0, 10),
      model: MODEL,
      effort: "medium",
      maxTokens: 8000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.decision.action === "COMMENT_ON") {
      expect(r.decision.stateGroup).toBe("started");
    }
  });

  it("canCreate + strong similar candidate → COMMENT_ON not CREATE", async () => {
    const r = await decidePass1({
      mode: "auto",
      email: {
        from: "vendor@bpcl",
        subject: "BPCL invoice ref 11915128",
        bodyText: "Following up on the invoice mismatch.",
        receivedAt: new Date(),
      },
      candidates: [bpclCandidate("started")],
      canCreate: true,
      projects: [
        { id: "proj-1", identifier: "P", name: "Personal", description: null },
      ],
      labelsByProject: { "proj-1": [{ id: "l1", name: "billing" }] },
      todayISO: new Date().toISOString().slice(0, 10),
      model: MODEL,
      effort: "medium",
      maxTokens: 8000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.decision.action).toBe("COMMENT_ON");
  });

  it("canCreate + no candidates → CREATE with sensible draft", async () => {
    const r = await decidePass1({
      mode: "auto",
      email: {
        from: "vendor@new",
        subject: "Schedule a meeting about onboarding",
        bodyText: "Hi — when can we sync about onboarding next week?",
        receivedAt: new Date(),
      },
      candidates: [],
      canCreate: true,
      projects: [
        { id: "proj-1", identifier: "P", name: "Personal", description: null },
      ],
      labelsByProject: { "proj-1": [] },
      todayISO: new Date().toISOString().slice(0, 10),
      model: MODEL,
      effort: "medium",
      maxTokens: 8000,
      timeoutMs: 60_000,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.decision.action === "CREATE") {
      expect(r.decision.draft.projectId).toBe("proj-1");
      expect(r.decision.draft.title.length).toBeGreaterThan(8);
    } else {
      expect.fail(
        `expected CREATE, got ${r.ok ? r.decision.action : r.errorMsg}`,
      );
    }
  });
});
