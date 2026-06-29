import { createScopedLogger } from "@/utils/logger";
import type { TaskpilotClient } from "@/utils/taskpilot/client";
import type { SimilarTaskHit } from "@/utils/taskpilot/similar";
import type { RichCandidate } from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-hydrate");

export interface ThreadLinkTarget {
  projectId: string;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  workspaceSlug: string;
}

export interface HydrateOptions {
  commentLimit: number;
  maxCandidates: number;
}

export async function hydrateCandidates(
  client: TaskpilotClient,
  similarHits: SimilarTaskHit[],
  threadLinkTarget: ThreadLinkTarget | null,
  opts: HydrateOptions,
): Promise<RichCandidate[]> {
  const seen = new Set<string>();
  const ordered: Array<
    Pick<
      RichCandidate,
      | "projectId"
      | "taskpilotIssueId"
      | "taskpilotIdentifier"
      | "workspaceSlug"
      | "score"
    >
  > = [];

  if (threadLinkTarget) {
    seen.add(threadLinkTarget.taskpilotIssueId);
    ordered.push({ ...threadLinkTarget, score: null });
  }

  for (const hit of similarHits) {
    if (ordered.length >= opts.maxCandidates) break;
    if (seen.has(hit.taskpilotIssueId)) continue;
    seen.add(hit.taskpilotIssueId);
    ordered.push({
      projectId: hit.projectId,
      taskpilotIssueId: hit.taskpilotIssueId,
      taskpilotIdentifier: hit.taskpilotIdentifier,
      workspaceSlug: hit.workspaceSlug,
      score: hit.score,
    });
  }

  const results: RichCandidate[] = [];
  for (const c of ordered) {
    try {
      const [detail, recentComments] = await Promise.all([
        client.getTask(c.projectId, c.taskpilotIssueId),
        client.listComments(c.projectId, c.taskpilotIssueId, opts.commentLimit),
      ]);
      results.push({ ...c, detail, recentComments });
    } catch (err) {
      logger.warn("hydrate: skipping candidate after fetch error", {
        err,
        issueId: c.taskpilotIssueId,
      });
    }
  }
  return results;
}
