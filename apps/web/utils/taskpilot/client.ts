import { createScopedLogger } from "@/utils/logger";
import {
  TaskpilotAuthError,
  TaskpilotNotFoundError,
  TaskpilotRateLimitError,
  TaskpilotServerError,
  TaskpilotValidationError,
} from "@/utils/taskpilot/errors";
import type {
  IssueLinkInput,
  Label,
  Project,
  WorkItemCreateInput,
  WorkItemCreateResult,
} from "@/utils/taskpilot/types";

const logger = createScopedLogger("taskpilot-client");

export interface TaskpilotClientOptions {
  apiKey: string;
  baseUrl?: string;
  workspaceSlug: string;
}

const DEFAULT_BASE_URL = "https://taskpilot-api.sudiptadhara.in";

export class TaskpilotClient {
  private readonly apiKey: string;
  private readonly workspaceSlug: string;
  private readonly baseUrl: string;

  constructor(opts: TaskpilotClientOptions) {
    this.apiKey = opts.apiKey;
    this.workspaceSlug = opts.workspaceSlug;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async listProjects(): Promise<Project[]> {
    const res = await this.request(
      "GET",
      `/workspaces/${this.workspaceSlug}/projects/`,
    );
    return unwrapList<Project>(await res.json());
  }

  async listLabels(projectId: string): Promise<Label[]> {
    const res = await this.request(
      "GET",
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/labels/`,
    );
    return unwrapList<Label>(await res.json());
  }

  async createWorkItem(
    projectId: string,
    input: WorkItemCreateInput,
  ): Promise<WorkItemCreateResult> {
    const res = await this.request(
      "POST",
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/`,
      input,
      { allow409: true },
    );
    const body = (await res.json()) as {
      id: string;
      identifier?: string;
      sequence_id?: number;
    };
    return {
      id: body.id,
      identifier: body.identifier ?? "",
      sequence_id: body.sequence_id ?? 0,
      alreadyExisted: res.status === 409,
    };
  }

  async addLink(issueId: string, input: IssueLinkInput): Promise<void> {
    await this.request(
      "POST",
      `/workspaces/${this.workspaceSlug}/work-items/${issueId}/links/`,
      input,
    );
  }

  async addComment(
    projectId: string,
    issueId: string,
    commentHtml: string,
  ): Promise<void> {
    await this.request(
      "POST",
      `/workspaces/${this.workspaceSlug}/projects/${projectId}/work-items/${issueId}/comments/`,
      { comment_html: commentHtml },
    );
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
    opts: { allow409?: boolean } = {},
  ): Promise<Response> {
    const url = `${this.baseUrl}/api/v1${path}`;
    const res = await fetch(url, {
      method,
      headers: {
        "X-Api-Key": this.apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (res.status === 200 || res.status === 201) return res;
    if (res.status === 409 && opts.allow409) return res;

    if (res.status === 401 || res.status === 403) {
      throw new TaskpilotAuthError(
        res.status,
        await safeMessage(res, "auth failed"),
      );
    }
    if (res.status === 404) {
      throw new TaskpilotNotFoundError(await safeMessage(res, "not found"));
    }
    if (res.status === 400 || res.status === 422) {
      throw new TaskpilotValidationError(
        res.status as 400 | 422,
        await safeMessage(res, "validation error"),
      );
    }
    if (res.status === 429) {
      const reset = Number(res.headers.get("X-RateLimit-Reset"));
      const resetAt = Number.isFinite(reset)
        ? new Date(reset * 1000)
        : new Date(Date.now() + 30_000);
      throw new TaskpilotRateLimitError(resetAt);
    }
    logger.warn("taskpilot non-success status", { status: res.status, url });
    throw new TaskpilotServerError(
      res.status,
      await safeMessage(res, "server error"),
    );
  }
}

async function safeMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    return body.error ?? body.detail ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * TaskPilot's REST list endpoints return either a bare array or a paginated
 * envelope `{count, results, next_cursor, ...}`. Unwrap both shapes so the
 * downstream `for (const x of list)` loops are safe.
 */
function unwrapList<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (
    body &&
    typeof body === "object" &&
    "results" in body &&
    Array.isArray((body as { results: unknown }).results)
  ) {
    return (body as { results: T[] }).results;
  }
  return [];
}
