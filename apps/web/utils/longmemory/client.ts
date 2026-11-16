import "server-only";
import { env } from "@/env";
import type { Logger } from "@/utils/logger";

/**
 * Long-term agentic memory, over the MCP server on the NUC.
 *
 * Why this exists: chat memory was a `content LIKE %query%` scan over
 * ChatMemory. "What time do they want the digest?" does not literally contain
 * "digest at 5am", so the agent asked questions it had already been answered.
 * This gives it semantic recall, and a supersession signal the local table has
 * no column for.
 *
 * Two things about this server that a naive client gets wrong:
 *
 * 1. Passing `user_id` returns `permission denied for user: …` — so we never
 *    send it. Isolation is by `project_id`, verified by execution: a memory
 *    ingested into inbox-<A> is not recallable from inbox-<B>.
 * 2. That denial arrives as `isError: true` inside an HTTP 200 JSON-RPC
 *    result. Read carelessly it looks like an empty memory store, and the
 *    agent then confidently says it knows nothing. An empty result is not
 *    evidence of an empty store, so isError throws here rather than returning
 *    [].
 */

/** Per-account scope. Isolation depends on this being unique per account. */
function projectId(emailAccountId: string): string {
  return `inbox-${emailAccountId}`;
}

export function isLongMemoryEnabled(): boolean {
  return Boolean(env.LONGMEMORY_BASE_URL && env.LONGMEMORY_API_KEY);
}

const REQUEST_TIMEOUT_MS = 15_000;

async function callLongMemory(
  tool: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const baseUrl = env.LONGMEMORY_BASE_URL;
  const apiKey = env.LONGMEMORY_API_KEY;

  if (!(baseUrl && apiKey)) throw new Error("Long memory is not configured");

  const response = await fetch(baseUrl, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      // The server replies with SSE framing unless it may also send JSON.
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(`Long memory ${tool} failed: HTTP ${response.status}`);
  }

  const envelope = parseJsonRpcBody(await response.text());

  if (envelope.error) {
    throw new Error(`Long memory ${tool} failed: ${envelope.error.message}`);
  }

  const result = envelope.result;
  const text = result?.content?.[0]?.text ?? "";

  // The trap. A permission denial is a successful HTTP 200 carrying isError.
  if (result?.isError) {
    throw new Error(`Long memory ${tool} returned an error: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

type JsonRpcEnvelope = {
  error?: { message?: string };
  result?: { isError?: boolean; content?: { text?: string }[] };
};

/** The endpoint answers with SSE framing; accept a bare JSON body too. */
function parseJsonRpcBody(body: string): JsonRpcEnvelope {
  const dataLine = body
    .split("\n")
    .find((line) => line.startsWith("data: "))
    ?.slice("data: ".length);

  return JSON.parse(dataLine ?? body);
}

export type LongMemory = { content: string; score: number };

/**
 * `mode: "strict"` keeps recall to what was actually stored — the other modes
 * (historical, associative, world_grounded) let the server reach for adjacent
 * or inferred material, which is the wrong trade when the answer becomes an
 * assertion about the owner's own preferences.
 */
export async function recallMemories({
  emailAccountId,
  query,
  tokenBudget = 1024,
}: {
  emailAccountId: string;
  query: string;
  tokenBudget?: number;
}): Promise<LongMemory[]> {
  if (!isLongMemoryEnabled()) return [];

  const payload = (await callLongMemory("longmemory_recall", {
    query,
    mode: "strict",
    project_id: projectId(emailAccountId),
    token_budget: tokenBudget,
  })) as RecallPayload | null;

  return (payload?.items ?? [])
    .filter((item) => item.node?.state?.status !== "superseded")
    .flatMap((item) => {
      const content = item.node?.content?.raw?.trim();
      return content ? [{ content, score: item.score ?? 0 }] : [];
    });
}

/**
 * Recall for background grounding, where a failure should not take the turn
 * down with it. Deliberately NOT the default: a caller that shows the user a
 * "no memories found" answer must be able to tell an empty store from an
 * unreachable one, so it has to opt into the silence.
 */
export async function recallMemoriesOrNone({
  emailAccountId,
  query,
  logger,
}: {
  emailAccountId: string;
  query: string;
  logger: Logger;
}): Promise<LongMemory[]> {
  try {
    return await recallMemories({ emailAccountId, query });
  } catch (error) {
    logger.warn("Long memory recall failed", { error });
    return [];
  }
}

type RecallPayload = {
  items?: {
    score?: number;
    node?: {
      content?: { raw?: string };
      state?: { status?: string };
    };
  }[];
};

/** Returns the stored memory id, or null when the write did not land. */
export async function ingestMemory({
  emailAccountId,
  text,
  source,
  logger,
}: {
  emailAccountId: string;
  text: string;
  source: string;
  logger: Logger;
}): Promise<string | null> {
  if (!isLongMemoryEnabled()) return null;

  try {
    const payload = (await callLongMemory("longmemory_ingest", {
      text,
      source,
      project_id: projectId(emailAccountId),
      memory_type: "manual_fact",
    })) as { memory_id?: string } | null;

    return payload?.memory_id ?? null;
  } catch (error) {
    logger.error("Long memory ingest failed", { error });
    return null;
  }
}
