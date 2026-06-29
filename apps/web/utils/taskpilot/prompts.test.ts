import { describe, expect, it } from "vitest";
import { buildPass1Prompt, buildPass2Prompt } from "@/utils/taskpilot/prompts";
import type { RichCandidate } from "@/utils/taskpilot/types";

const exampleCandidate: RichCandidate = {
  projectId: "proj-1",
  taskpilotIssueId: "iss-1",
  taskpilotIdentifier: "INBOXEMAIL-12",
  workspaceSlug: "ws",
  score: 0.81,
  detail: {
    id: "iss-1",
    identifier: "INBOXEMAIL-12",
    name: "Resolve BPCL invoice mismatch",
    description_html: "<p>Distributor sent <strong>wrong</strong> figure.</p>",
    state: { id: "s1", name: "In Progress", group: "started" },
    priority: "high",
    assignees: [],
    labels: [
      { id: "l1", name: "billing" },
      { id: "l2", name: "vendor:BPCL" },
    ],
  },
  recentComments: [
    {
      id: "c1",
      author_display_name: "sudipta",
      comment_html: "<p>note</p>",
      created_at: "2026-06-01T00:00:00Z",
    },
  ],
};

describe("buildPass1Prompt", () => {
  it("auto mode permits all three actions and includes the canCreate flag", () => {
    const { system, user } = buildPass1Prompt({
      mode: "auto",
      email: {
        from: "x@y",
        subject: "s",
        bodyText: "b",
        receivedAt: new Date("2026-06-29T00:00:00Z"),
      },
      candidates: [exampleCandidate],
      canCreate: true,
      projects: [
        { id: "proj-1", identifier: "P", name: "Personal", description: null },
      ],
      labelsByProject: {
        "proj-1": [
          { id: "l1", name: "billing" },
          { id: "l2", name: "vendor:BPCL" },
        ],
      },
      todayISO: "2026-06-29",
    });
    expect(system).toMatch(/IGNORE/);
    expect(system).toMatch(/COMMENT_ON/);
    expect(system).toMatch(/CREATE/);
    expect(user).toMatch(/canCreate: true/);
    expect(user).toMatch(/INBOXEMAIL-12/);
    expect(user).toMatch(/billing/);
  });

  it("force_create mode tells the model to always return CREATE", () => {
    const { system } = buildPass1Prompt({
      mode: "force_create",
      email: {
        from: "x@y",
        subject: "s",
        bodyText: "b",
        receivedAt: new Date("2026-06-29T00:00:00Z"),
      },
      candidates: [],
      canCreate: true,
      projects: [
        { id: "proj-1", identifier: "P", name: "Personal", description: null },
      ],
      labelsByProject: { "proj-1": [] },
      todayISO: "2026-06-29",
    });
    expect(system).toMatch(/MUST return action: "CREATE"/i);
  });

  it("user prompt strips HTML from candidate description", () => {
    const { user } = buildPass1Prompt({
      mode: "auto",
      email: {
        from: "x@y",
        subject: "s",
        bodyText: "b",
        receivedAt: new Date("2026-06-29T00:00:00Z"),
      },
      candidates: [exampleCandidate],
      canCreate: false,
      projects: [],
      labelsByProject: {},
      todayISO: "2026-06-29",
    });
    expect(user).not.toContain("<p>");
    expect(user).toContain("Distributor sent wrong figure.");
  });

  it("excludes PROJECTS section when canCreate=false", () => {
    const { user } = buildPass1Prompt({
      mode: "auto",
      email: {
        from: "x@y",
        subject: "s",
        bodyText: "b",
        receivedAt: new Date("2026-06-29T00:00:00Z"),
      },
      candidates: [exampleCandidate],
      canCreate: false,
      projects: [
        { id: "proj-1", identifier: "P", name: "Personal", description: null },
      ],
      labelsByProject: { "proj-1": [{ id: "l1", name: "billing" }] },
      todayISO: "2026-06-29",
    });
    expect(user).not.toMatch(/## PROJECTS/);
    expect(user).not.toMatch(/## LABELS BY PROJECT/);
  });
});

describe("buildPass2Prompt", () => {
  it("includes candidate priorities so model can avoid no-op suggestions", () => {
    const { system, user } = buildPass2Prompt({
      email: { from: "x@y", subject: "s", bodyText: "b" },
      executedTargets: [exampleCandidate],
      projectLabels: { "proj-1": ["billing", "vendor:BPCL", "urgent"] },
      workspaceMembers: ["john@example.com"],
      todayISO: "2026-06-29",
    });
    expect(system).toMatch(/explicit/i);
    expect(user).toMatch(/currentPriority: high/);
    expect(user).toMatch(/john@example.com/);
  });
});
