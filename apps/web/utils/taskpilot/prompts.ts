import type { Label, Project, RichCandidate } from "@/utils/taskpilot/types";

export type Pass1Mode = "auto" | "force_create";

export interface Pass1PromptInput {
  canCreate: boolean;
  candidates: RichCandidate[];
  email: {
    from: string;
    subject: string;
    bodyText: string;
    receivedAt: Date;
  };
  labelsByProject: Record<string, Label[]>;
  mode: Pass1Mode;
  projects: Project[];
  todayISO: string;
}

export interface Pass2PromptInput {
  email: { from: string; subject: string; bodyText: string };
  executedTargets: RichCandidate[];
  projectLabels: Record<string, string[]>;
  todayISO: string;
  workspaceMembers: string[];
}

const BODY_TRUNCATE = 4000;

const PASS1_SYSTEM_AUTO = `You are the TaskPilot routing brain for a personal inbox. An email has just arrived. Decide ONE of: IGNORE, COMMENT_ON (one or more existing tasks), or CREATE (a new task — only if explicitly allowed).

Hard rules:
- If canCreate is false, you MUST choose IGNORE or COMMENT_ON. Never CREATE.
- targetIssueIds must come from the candidates list. Never invent IDs.
- Default to IGNORE if the email is an auto-reply, out-of-office, calendar invite, receipt, marketing, or contains no substantive update on any candidate.
- State moves to "completed" or "cancelled" require HIGH confidence — strong, unambiguous language ("issue resolved", "request closed", "we're cancelling this"). When in doubt, leave stateGroup: null.
- Reopen (stateGroup: "started") when a candidate is currently "completed" or "cancelled" AND the email indicates the issue is back or not actually fixed.
- Set fieldUpdatesNeeded: true ONLY when the email contains explicit signals to change priority ("urgent now"), due date ("by Friday"), assignee ("handing to John"), or labels ("this is a billing issue"). Don't flag it just because something might be inferable.

Comment writing:
- summary: 1–2 sentences in plain prose. Describe the DELTA — what's new since the existing task state, not a restatement of the email. Past tense. No "the user says…" — say it directly.
- highlights: optional bullets. Use for hard facts: quoted figures, deadlines, names, ticket numbers, decisions. Skip if there are none.

CREATE rules (only if canCreate):
- If ANY candidate is the same underlying issue (even if scored below match threshold), prefer COMMENT_ON. Only CREATE when this is genuinely a new, distinct issue.
- Title: imperative + specific. "Resolve BPCL invoice mismatch on ref 11915128" not "BPCL email".
- Description: include sender, the ask, deadlines, and any reference numbers. HTML, but use only <p>, <ul>/<li>, <strong>, <a>.

Output JSON only — no prose, no markdown fences.`;

const PASS1_SYSTEM_FORCE_CREATE = `You are the TaskPilot routing brain. A user explicitly requested that this email be converted into a new TaskPilot task. You MUST return action: "CREATE" with a high-quality draft.

Even though candidate tasks are provided for context, you are NOT permitted to choose COMMENT_ON or IGNORE — the user has bypassed the dedupe decision.

Drafting rules:
- Title: imperative + specific. Not "BPCL email" — "Resolve BPCL invoice mismatch on reference 11915128".
- Description: include sender, the ask, deadlines, reference numbers. If a candidate is clearly related, you may MENTION it in the description ("Related to <identifier> — different line item") but do not block creation.
- Use only <p>, <ul>/<li>, <strong>, <a> in descriptionHtml.
- Pick the most appropriate project from the PROJECTS list.
- Pick label names from the project's LABELS list. Never invent new ones.
- targetDate: YYYY-MM-DD if the email contains a deadline; otherwise null.

Output JSON only — no prose, no markdown fences.`;

const PASS2_SYSTEM = `Email and existing task context were already used to produce a COMMENT_ON decision. Now: extract concrete field-level changes the email explicitly signals.

- Only emit changes the email STATES. Do not infer priority from your own judgment of severity — only from words like "urgent", "ASAP", "this is now P0", "low priority".
- Only emit targetDate when the email contains a concrete date or deadline ("by Friday", "before Jan 15"). Resolve relative dates to YYYY-MM-DD using today.
- Only emit addLabelNames from the provided project labels list. Never invent new labels.
- Only emit assigneeEmail if the email contains language like "assigning to X", "handing this to Y@", "X will take this over". Don't assign based on sender or CC alone.
- When the email says nothing concrete about a field, leave it null / empty.

Output JSON only — no prose, no markdown fences.`;

export function buildPass1Prompt(input: Pass1PromptInput): {
  system: string;
  user: string;
} {
  const system =
    input.mode === "force_create"
      ? PASS1_SYSTEM_FORCE_CREATE
      : PASS1_SYSTEM_AUTO;

  const parts: string[] = [
    "## EMAIL",
    `From: ${input.email.from}`,
    `Subject: ${input.email.subject}`,
    `Received: ${input.email.receivedAt.toISOString()}`,
    "Body:",
    truncate(input.email.bodyText, BODY_TRUNCATE),
    "",
    "## CONTEXT",
    `canCreate: ${input.canCreate}`,
    `today: ${input.todayISO}`,
    "",
    `## CANDIDATES (top ${input.candidates.length}, ordered by similarity)`,
  ];

  if (input.candidates.length === 0) {
    parts.push("(none)");
  } else {
    input.candidates.forEach((c, i) => {
      const scoreText =
        c.score === null ? "thread-linked" : `score: ${c.score.toFixed(2)}`;
      parts.push("");
      parts.push(
        `### Candidate ${i + 1} — ${c.taskpilotIdentifier} (${scoreText}, currentState: ${c.detail.state.name}/${c.detail.state.group}, priority: ${c.detail.priority})`,
      );
      parts.push(`Title: ${c.detail.name}`);
      parts.push(`Description: ${stripHtml(c.detail.description_html)}`);
      parts.push(`Labels: [${c.detail.labels.map((l) => l.name).join(", ")}]`);
      parts.push(
        `Assignee: ${c.detail.assignees[0]?.email ?? c.detail.assignees[0]?.display_name ?? "none"}`,
      );
      parts.push(`issueId: ${c.taskpilotIssueId}`);
      parts.push(`Last ${c.recentComments.length} comments (oldest first):`);
      for (const cm of c.recentComments) {
        parts.push(
          `- ${cm.created_at.slice(0, 10)} from ${cm.author_display_name}: ${stripHtml(cm.comment_html)}`,
        );
      }
    });
  }

  if (input.canCreate) {
    parts.push("");
    parts.push("## PROJECTS");
    for (const p of input.projects) {
      parts.push(`- projectId: ${p.id}, name: "${p.name}"`);
    }
    parts.push("");
    parts.push("## LABELS BY PROJECT");
    for (const [projectId, labels] of Object.entries(input.labelsByProject)) {
      parts.push(`- ${projectId}: [${labels.map((l) => l.name).join(", ")}]`);
    }
  }

  return { system, user: parts.join("\n") };
}

export function buildPass2Prompt(input: Pass2PromptInput): {
  system: string;
  user: string;
} {
  const parts: string[] = [
    "## EMAIL",
    `From: ${input.email.from}`,
    `Subject: ${input.email.subject}`,
    "Body:",
    truncate(input.email.bodyText, BODY_TRUNCATE),
    "",
    `today: ${input.todayISO}`,
    "",
    "## EXECUTED TARGETS",
  ];

  for (const t of input.executedTargets) {
    parts.push("");
    parts.push(
      `### ${t.taskpilotIdentifier}  (issueId: ${t.taskpilotIssueId})`,
    );
    parts.push(`currentPriority: ${t.detail.priority}`);
    parts.push(
      `currentLabels: [${t.detail.labels.map((l) => l.name).join(", ")}]`,
    );
    parts.push(
      `currentAssignee: ${t.detail.assignees[0]?.email ?? t.detail.assignees[0]?.display_name ?? "none"}`,
    );
    parts.push(`currentTargetDate: ${t.detail.target_date ?? "none"}`);
    parts.push(`projectId: ${t.projectId}`);
  }

  parts.push("");
  parts.push(
    "## PROJECT LABELS (only these names are valid for addLabelNames)",
  );
  for (const [projectId, labels] of Object.entries(input.projectLabels)) {
    parts.push(`- ${projectId}: [${labels.join(", ")}]`);
  }

  parts.push("");
  parts.push(
    "## WORKSPACE MEMBER EMAILS (only these are valid for assigneeEmail)",
  );
  for (const email of input.workspaceMembers) {
    parts.push(`- ${email}`);
  }

  return { system: PASS2_SYSTEM, user: parts.join("\n") };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…[truncated]` : s;
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}
