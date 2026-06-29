import { describe, expect, it } from "vitest";
import { Pass1Schema, Pass2Schema } from "@/utils/taskpilot/schemas";

describe("Pass1Schema", () => {
  it("accepts a valid IGNORE", () => {
    const r = Pass1Schema.safeParse({
      action: "IGNORE",
      reason: "out of office",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid COMMENT_ON with all fields", () => {
    const r = Pass1Schema.safeParse({
      action: "COMMENT_ON",
      targetIssueIds: ["a"],
      comment: { summary: "x", highlights: [] },
      stateGroup: "completed",
      stateConfidence: "HIGH",
      fieldUpdatesNeeded: false,
      reason: "resolved",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a valid CREATE", () => {
    const r = Pass1Schema.safeParse({
      action: "CREATE",
      draft: {
        projectId: "p",
        title: "t",
        descriptionHtml: "<p>d</p>",
        priority: "medium",
        labelNames: [],
        targetDate: null,
      },
      reason: "new issue",
    });
    expect(r.success).toBe(true);
  });

  it("rejects COMMENT_ON with 0 target IDs", () => {
    const r = Pass1Schema.safeParse({
      action: "COMMENT_ON",
      targetIssueIds: [],
      comment: { summary: "x", highlights: [] },
      stateGroup: null,
      stateConfidence: "LOW",
      fieldUpdatesNeeded: false,
      reason: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects mixed-variant fields (CREATE with targetIssueIds)", () => {
    const r = Pass1Schema.safeParse({
      action: "CREATE",
      targetIssueIds: ["a"],
      reason: "x",
    });
    expect(r.success).toBe(false);
  });

  it("rejects invalid stateGroup enum", () => {
    const r = Pass1Schema.safeParse({
      action: "COMMENT_ON",
      targetIssueIds: ["a"],
      comment: { summary: "x", highlights: [] },
      stateGroup: "done", // not a valid group
      stateConfidence: "HIGH",
      fieldUpdatesNeeded: false,
      reason: "x",
    });
    expect(r.success).toBe(false);
  });
});

describe("Pass2Schema", () => {
  it("accepts an empty updates array", () => {
    const r = Pass2Schema.safeParse({
      updates: [],
      reason: "nothing concrete",
    });
    expect(r.success).toBe(true);
  });

  it("accepts an update with priority change only", () => {
    const r = Pass2Schema.safeParse({
      updates: [
        {
          targetIssueId: "a",
          priority: "urgent",
          targetDate: null,
          addLabelNames: [],
          removeLabelNames: [],
          assigneeEmail: null,
        },
      ],
      reason: "explicit urgent in email",
    });
    expect(r.success).toBe(true);
  });
});
