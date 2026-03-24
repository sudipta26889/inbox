import { createScopedLogger } from "@/utils/logger";
import { env } from "@/env";

const logger = createScopedLogger("a2a-client");

const A2A_TIMEOUT_MS = 10_000;

type AgentCard = {
  name: string;
  version?: string;
  skills?: Array<{ skill: string; name?: string; description?: string }>;
  bindings?: Array<{ url: string; transport: string }>;
};

type A2aMessageParams = {
  content?: string;
  input?: Record<string, unknown>;
  contextId?: string;
};

type A2aResult = {
  taskId?: string;
  state?: string;
  error?: { code: number; message: string };
};

export async function fetchAgentCard(agentBaseUrl: string): Promise<AgentCard> {
  const url = `${agentBaseUrl.replace(/\/$/, "")}/.well-known/agent-card.json`;
  const response = await fetch(url, {
    signal: AbortSignal.timeout(A2A_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to fetch agent card from ${url}: ${response.status}`,
    );
  }

  return response.json();
}

export async function resolveA2aEndpoint(
  agentBaseUrl: string,
): Promise<string> {
  const base = agentBaseUrl.replace(/\/$/, "");

  try {
    const card = await fetchAgentCard(base);
    const binding = card.bindings?.find((b) => b.transport === "json-rpc");
    if (binding?.url) {
      return binding.url.startsWith("http")
        ? binding.url
        : `${base}${binding.url}`;
    }
  } catch (error) {
    logger.warn("Failed to fetch agent card, falling back to /a2a", {
      agentBaseUrl,
      error,
    });
  }

  return `${base}/a2a`;
}

export async function sendA2aMessage(
  endpoint: string,
  params: A2aMessageParams,
): Promise<A2aResult> {
  const body = {
    jsonrpc: "2.0",
    id: Date.now(),
    method: "message.send",
    params: {
      content: params.content,
      input: params.input,
      contextId: params.contextId || `inbox-${Date.now()}`,
    },
  };

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(A2A_TIMEOUT_MS),
    });

    const json = await response.json();

    if (json.error) {
      logger.error("A2A agent returned error", {
        endpoint,
        error: json.error,
      });
      return { error: json.error };
    }

    logger.info("A2A message sent successfully", {
      endpoint,
      taskId: json.result?.taskId,
      state: json.result?.state,
    });

    return { taskId: json.result?.taskId, state: json.result?.state };
  } catch (error) {
    logger.error("A2A message send failed", { endpoint, error });
    return {
      error: {
        code: -1,
        message: error instanceof Error ? error.message : "Unknown error",
      },
    };
  }
}

export function getRemoteAgentUrls(): string[] {
  const raw = env.A2A_REMOTE_AGENTS;
  if (!raw) return [];
  return raw
    .split(",")
    .map((url) => url.trim())
    .filter(Boolean);
}

export function buildA2aEmailPayload(
  email: {
    from: string;
    subject: string;
    snippet?: string;
    threadId: string;
    messageId: string;
    labels?: string[];
    receivedAt?: Date;
  },
  rule: { ruleName?: string; ruleId: string },
): { content: string; input: Record<string, unknown> } {
  return {
    content: `Urgent email from ${email.from}: ${email.subject}`,
    input: {
      from: email.from,
      subject: email.subject,
      snippet: email.snippet,
      thread_id: email.threadId,
      message_id: email.messageId,
      labels: email.labels,
      received_at: email.receivedAt?.toISOString(),
      rule_name: rule.ruleName,
      rule_id: rule.ruleId,
      timestamp: new Date().toISOString(),
    },
  };
}
