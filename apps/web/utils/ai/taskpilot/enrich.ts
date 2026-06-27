import { z } from "zod";
import { createScopedLogger } from "@/utils/logger";
import type { Label, Project } from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-enrich");

export const INBOX_LINK_PLACEHOLDER = "{{INBOX_LINK}}";

export interface EnrichmentEmail {
  bodyText: string;
  from: string;
  receivedAt: Date;
  snippet?: string;
  subject: string;
}

type ChatCompletionFn = (args: {
  prompt: string;
  schema: z.ZodTypeAny;
}) => Promise<{ object: unknown }>;

export interface EnrichmentInput {
  /** Injected by the service layer (Task 7). Tests inject their own mock. */
  chatCompletionObject?: ChatCompletionFn;
  email: EnrichmentEmail;
  labelsByProject: Map<string, Label[]>;
  projects: Project[];
  ruleContext?: string;
}

export interface EnrichedTaskDraft {
  description_html: string;
  labelNames: string[];
  priority: "urgent" | "high" | "medium" | "low" | "none";
  projectId: string;
  targetDate?: string;
  title: string;
}

const draftSchema = z.object({
  projectId: z.string(),
  title: z.string().min(1).max(200),
  description_html: z.string().min(1),
  priority: z.enum(["urgent", "high", "medium", "low", "none"]),
  labelNames: z.array(z.string()).default([]),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export async function enrichEmailIntoTask(
  input: EnrichmentInput,
): Promise<EnrichedTaskDraft> {
  const chat = input.chatCompletionObject ?? defaultChat;
  const prompt = buildPrompt(input);
  try {
    const { object } = await chat({ prompt, schema: draftSchema });
    const parsed = draftSchema.safeParse(object);
    if (!parsed.success) {
      logger.warn("enrichment Zod parse failed", {
        issues: parsed.error.issues,
      });
      return fallback(input);
    }
    const draft = parsed.data;
    const validProject = input.projects.find((p) => p.id === draft.projectId);
    if (!validProject) {
      logger.warn("enrichment returned invalid projectId; falling back", {
        projectId: draft.projectId,
      });
      return fallback(input);
    }
    const allowedLabels = new Set(
      (input.labelsByProject.get(draft.projectId) ?? []).map((l) => l.name),
    );
    const labelNames = draft.labelNames.filter((n) => allowedLabels.has(n));
    return {
      projectId: draft.projectId,
      title: truncate(stripReplyPrefix(draft.title), 100),
      description_html: draft.description_html,
      priority: draft.priority,
      labelNames,
      targetDate: draft.targetDate,
    };
  } catch (err) {
    logger.warn("enrichment threw; falling back", { err });
    return fallback(input);
  }
}

function fallback(input: EnrichmentInput): EnrichedTaskDraft {
  const project = input.projects[0];
  const title = truncate(
    stripReplyPrefix(input.email.subject || "Untitled task"),
    100,
  );
  const bodyExcerpt = truncate(
    input.email.bodyText.replace(/\s+/g, " ").trim(),
    400,
  );
  return {
    projectId: project?.id ?? "",
    title,
    description_html:
      `<p>From: ${escapeHtml(input.email.from)}</p>` +
      `<p>${escapeHtml(bodyExcerpt)}</p>` +
      `<a href="${INBOX_LINK_PLACEHOLDER}">Open in Inbox</a>`,
    priority: "medium",
    labelNames: [],
  };
}

function buildPrompt(input: EnrichmentInput): string {
  const projectLines = input.projects
    .map(
      (p) => `- ${p.id} (${p.identifier}): ${p.name} — ${p.description ?? ""}`,
    )
    .join("\n");
  const labelsLines = Array.from(input.labelsByProject.entries())
    .map(
      ([pid, labels]) =>
        `  ${pid}: [${labels.map((l) => JSON.stringify(l.name)).join(", ")}]`,
    )
    .join("\n");
  return [
    "You convert an email into a TaskPilot task. Output JSON matching the schema strictly.",
    "Constraints:",
    "- projectId MUST be one of the provided UUIDs.",
    "- priority MUST be one of urgent|high|medium|low|none.",
    "- labelNames MUST be a subset of the labels for the chosen projectId (exact match).",
    "- targetDate ONLY if the email explicitly mentions a deadline; format YYYY-MM-DD.",
    "- title: action-oriented, ≤100 chars, no Re:/Fwd: prefixes.",
    `- description_html: short sanitized HTML; end with <a href="${INBOX_LINK_PLACEHOLDER}">Open in Inbox</a>.`,
    "",
    `Routing context: ${input.ruleContext ?? "(none)"}`,
    "",
    "Email:",
    `  Subject: ${input.email.subject}`,
    `  From: ${input.email.from}`,
    `  ReceivedAt: ${input.email.receivedAt.toISOString()}`,
    `  Body: ${input.email.bodyText}`,
    "",
    "Projects:",
    projectLines,
    "",
    "Labels by projectId:",
    labelsLines,
  ].join("\n");
}

function stripReplyPrefix(s: string): string {
  return s.replace(/^(\s*(re|fwd|fw)\s*:\s*)+/i, "").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const defaultChat: ChatCompletionFn = () => {
  throw new Error(
    "enrichEmailIntoTask: no chatCompletionObject injected — Task 7's service layer must pass one (createGenerateObject from @/utils/llms with the caller's emailAccount in scope).",
  );
};
