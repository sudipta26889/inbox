import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("taskpilot-similar");

// ponytail: hardcoded knobs. promote to env if anyone needs to tune live.
const COLLECTION = "taskpilot_tasks";
const EMBED_MODEL = "nomic-embed-text"; // 768d, local via litellm

export interface SimilarTaskHit {
  projectId: string;
  score: number;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  workspaceSlug: string;
}

export interface IndexTaskInput {
  emailAccountId: string;
  projectId: string;
  taskpilotIdentifier: string;
  taskpilotIssueId: string;
  text: string;
  workspaceSlug: string;
}

export async function findSimilarTasksTopK(
  emailAccountId: string,
  text: string,
  k: number,
  scoreThreshold: number,
): Promise<SimilarTaskHit[]> {
  const qdrantUrl = env.QDRANT_URL;
  if (!qdrantUrl) return [];

  try {
    const vector = await embed(text);
    if (!vector) return [];

    const res = await fetch(
      `${qdrantUrl.replace(/\/$/, "")}/collections/${COLLECTION}/points/search`,
      {
        method: "POST",
        headers: qdrantHeaders(),
        body: JSON.stringify({
          vector,
          limit: k,
          with_payload: true,
          score_threshold: scoreThreshold,
          filter: {
            must: [{ key: "emailAccountId", match: { value: emailAccountId } }],
          },
        }),
      },
    );
    if (!res.ok) {
      logger.warn("qdrant search non-ok", { status: res.status });
      return [];
    }
    const body = (await res.json()) as {
      result?: Array<{
        score: number;
        payload?: {
          taskpilotIssueId?: string;
          taskpilotIdentifier?: string;
          workspaceSlug?: string;
          projectId?: string;
        };
      }>;
    };
    return (body.result ?? [])
      .filter((r) => r.payload?.taskpilotIssueId)
      .map((r) => ({
        taskpilotIssueId: r.payload!.taskpilotIssueId!,
        taskpilotIdentifier: r.payload!.taskpilotIdentifier ?? "",
        workspaceSlug: r.payload!.workspaceSlug ?? "",
        projectId: r.payload!.projectId ?? "",
        score: r.score,
      }));
  } catch (err) {
    logger.warn("findSimilarTasksTopK failed; returning []", { err });
    return [];
  }
}

export async function indexTask(input: IndexTaskInput): Promise<void> {
  const qdrantUrl = env.QDRANT_URL;
  if (!qdrantUrl) return;

  try {
    const vector = await embed(input.text);
    if (!vector) return;

    // Use taskpilotIssueId (UUID) as point id — deterministic, idempotent upsert.
    const res = await fetch(
      `${qdrantUrl.replace(/\/$/, "")}/collections/${COLLECTION}/points?wait=true`,
      {
        method: "PUT",
        headers: qdrantHeaders(),
        body: JSON.stringify({
          points: [
            {
              id: input.taskpilotIssueId,
              vector,
              payload: {
                emailAccountId: input.emailAccountId,
                taskpilotIssueId: input.taskpilotIssueId,
                taskpilotIdentifier: input.taskpilotIdentifier,
                workspaceSlug: input.workspaceSlug,
                projectId: input.projectId,
              },
            },
          ],
        }),
      },
    );
    if (!res.ok) {
      logger.warn("qdrant index non-ok", { status: res.status });
    }
  } catch (err) {
    logger.warn("indexTask failed; create succeeded but no vector recorded", {
      err,
    });
  }
}

async function embed(text: string): Promise<number[] | null> {
  const baseUrl =
    env.OPENAI_COMPATIBLE_BASE_URL ?? env.LITELLM_BASE_URL ?? null;
  if (!baseUrl) {
    logger.warn("no OPENAI_COMPATIBLE_BASE_URL/LITELLM_BASE_URL configured");
    return null;
  }
  const res = await fetch(`${baseUrl.replace(/\/$/, "")}/embeddings`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.LLM_API_KEY
        ? { Authorization: `Bearer ${env.LLM_API_KEY}` }
        : {}),
    },
    body: JSON.stringify({
      model: EMBED_MODEL,
      input: text.slice(0, 8000), // ponytail: cap input. nomic context is 8k tokens
    }),
  });
  if (!res.ok) {
    logger.warn("embed non-ok", { status: res.status });
    return null;
  }
  const body = (await res.json()) as {
    data?: Array<{ embedding?: number[] }>;
  };
  return body.data?.[0]?.embedding ?? null;
}

function qdrantHeaders(): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(env.QDRANT_API_KEY ? { "api-key": env.QDRANT_API_KEY } : {}),
  };
}
