import { createScopedLogger } from "@/utils/logger";
import { indexTask } from "@/utils/taskpilot/similar";
import type { TaskpilotClient } from "@/utils/taskpilot/client";
import type { TaskComment, TaskDetail } from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-reindex");

const MAX_COMMENTS = 10;

export interface ReindexTarget {
  projectId: string;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  workspaceSlug: string;
}

export function buildReindexPayload(
  detail: TaskDetail,
  comments: TaskComment[],
): string {
  const desc = stripHtml(detail.description_html);
  const labels = detail.labels.map((l) => l.name).join(", ");
  const recent = comments.slice(-MAX_COMMENTS); // oldest-first input → keep last 10
  const commentLines = recent.map((c) => {
    const date = c.created_at.slice(0, 10);
    const text = stripHtml(c.comment_html);
    return `[${date}] (${c.author_display_name}): ${text}`;
  });

  return [
    `Title: ${detail.name}`,
    "",
    "Description:",
    desc,
    "",
    `Labels: ${labels}`,
    "",
    `State: ${detail.state.name} (${detail.state.group})`,
    "",
    `Recent comments (oldest first, up to last ${MAX_COMMENTS}):`,
    ...commentLines,
  ].join("\n");
}

export async function reindexTask(
  client: TaskpilotClient,
  emailAccountId: string,
  target: ReindexTarget,
): Promise<void> {
  try {
    const [detail, comments] = await Promise.all([
      client.getTask(target.projectId, target.taskpilotIssueId),
      client.listComments(
        target.projectId,
        target.taskpilotIssueId,
        MAX_COMMENTS,
      ),
    ]);
    const text = buildReindexPayload(detail, comments);
    await indexTask({
      emailAccountId,
      taskpilotIssueId: target.taskpilotIssueId,
      taskpilotIdentifier: target.taskpilotIdentifier,
      workspaceSlug: target.workspaceSlug,
      projectId: target.projectId,
      text,
    });
  } catch (err) {
    logger.warn("reindexTask failed; vector stale until next refresh", {
      err,
      issueId: target.taskpilotIssueId,
    });
  }
}

// ponytail: regex strip is sufficient for nomic-embed; swap for a real parser
// if matching quality degrades on heavily formatted HTML.
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
