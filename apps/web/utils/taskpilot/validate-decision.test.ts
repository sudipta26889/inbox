import { describe, expect, it } from "vitest";
import { validatePass1Decision } from "@/utils/taskpilot/validate-decision";
import type { Pass1Decision } from "@/utils/taskpilot/schemas";

const ctx = {
  canCreate: false,
  candidateIssueIds: new Set(["iss-1", "iss-2"]),
  projectIds: new Set(["proj-1"]),
  projectLabels: new Map([["proj-1", new Set(["billing", "vendor:BPCL"])]]),
};

describe("validatePass1Decision", () => {
  it("passes through a clean IGNORE", () => {
    const d: Pass1Decision = { action: "IGNORE", reason: "x" };
    const r = validatePass1Decision(d, ctx);
    expect(r.kind).toBe("ok");
  });

  it("downgrades CREATE when canCreate=false", () => {
    const d: Pass1Decision = {
      action: "CREATE",
      draft: {
        projectId: "proj-1",
        title: "t",
        descriptionHtml: "",
        priority: "medium",
        labelNames: [],
        targetDate: null,
      },
      reason: "x",
    };
    const r = validatePass1Decision(d, ctx);
    expect(r.kind).toBe("downgrade");
    if (r.kind === "downgrade") expect(r.reason).toMatch(/canCreate/);
  });

  it("downgrades CREATE with unknown projectId", () => {
    const d: Pass1Decision = {
      action: "CREATE",
      draft: {
        projectId: "unknown",
        title: "t",
        descriptionHtml: "",
        priority: "medium",
        labelNames: [],
        targetDate: null,
      },
      reason: "x",
    };
    const r = validatePass1Decision(d, { ...ctx, canCreate: true });
    expect(r.kind).toBe("downgrade");
    if (r.kind === "downgrade") expect(r.reason).toMatch(/project/i);
  });

  it("filters unknown labelNames from CREATE draft", () => {
    const d: Pass1Decision = {
      action: "CREATE",
      draft: {
        projectId: "proj-1",
        title: "t",
        descriptionHtml: "",
        priority: "medium",
        labelNames: ["billing", "bogus"],
        targetDate: null,
      },
      reason: "x",
    };
    const r = validatePass1Decision(d, { ...ctx, canCreate: true });
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.decision.action === "CREATE") {
      expect(r.decision.draft.labelNames).toEqual(["billing"]);
    }
  });

  it("drops hallucinated targetIssueIds; if all dropped, downgrade", () => {
    const d: Pass1Decision = {
      action: "COMMENT_ON",
      targetIssueIds: ["hallucinated", "iss-1"],
      comment: { summary: "x", highlights: [] },
      stateGroup: null,
      stateConfidence: "LOW",
      fieldUpdatesNeeded: false,
      reason: "x",
    };
    const r = validatePass1Decision(d, ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.decision.action === "COMMENT_ON") {
      expect(r.decision.targetIssueIds).toEqual(["iss-1"]);
    }

    const allBad: Pass1Decision = {
      action: "COMMENT_ON",
      targetIssueIds: ["bogus1", "bogus2"],
      comment: { summary: "x", highlights: [] },
      stateGroup: null,
      stateConfidence: "LOW",
      fieldUpdatesNeeded: false,
      reason: "x",
    };
    const r2 = validatePass1Decision(allBad, ctx);
    expect(r2.kind).toBe("downgrade");
  });

  it("drops terminal-state transitions below HIGH confidence", () => {
    const d: Pass1Decision = {
      action: "COMMENT_ON",
      targetIssueIds: ["iss-1"],
      comment: { summary: "x", highlights: [] },
      stateGroup: "completed",
      stateConfidence: "MEDIUM",
      fieldUpdatesNeeded: false,
      reason: "x",
    };
    const r = validatePass1Decision(d, ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.decision.action === "COMMENT_ON") {
      expect(r.decision.stateGroup).toBeNull();
    }
  });

  it("keeps non-terminal transitions at MEDIUM confidence", () => {
    const d: Pass1Decision = {
      action: "COMMENT_ON",
      targetIssueIds: ["iss-1"],
      comment: { summary: "x", highlights: [] },
      stateGroup: "started",
      stateConfidence: "MEDIUM",
      fieldUpdatesNeeded: false,
      reason: "x",
    };
    const r = validatePass1Decision(d, ctx);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok" && r.decision.action === "COMMENT_ON") {
      expect(r.decision.stateGroup).toBe("started");
    }
  });
});
