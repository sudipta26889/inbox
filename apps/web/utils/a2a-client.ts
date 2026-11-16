import crypto from "node:crypto";
import { createScopedLogger } from "@/utils/logger";
import { env } from "@/env";

const logger = createScopedLogger("a2a-client");

// Card discovery is a plain GET and should be quick.
const A2A_CARD_TIMEOUT_MS = 10_000;
// message/send with blocking:true waits for the remote agent's whole run.
// Mitra measured 11.1s for a trivial prompt, so the old shared 10s budget
// aborted the request just before it completed.
const A2A_TIMEOUT_MS = 120_000;

type AgentInterface = {
  url: string;
  /** A2A v0.3 and OpenClaw's older cards. */
  transport?: string;
  /** Newer A2A cards name the same thing `protocolBinding`. */
  protocolBinding?: string;
};

type AgentCard = {
  name: string;
  version?: string;
  url?: string;
  skills?: Array<{ id?: string; skill?: string; name?: string }>;
  bindings?: AgentInterface[];
  additionalInterfaces?: AgentInterface[];
  supportedInterfaces?: AgentInterface[];
};

type A2aMessageParams = {
  text: string;
  data?: Record<string, unknown>;
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
    signal: AbortSignal.timeout(A2A_CARD_TIMEOUT_MS),
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

    // bindings (A2A v0.3), additionalInterfaces (older OpenClaw) and
    // supportedInterfaces (newer OpenClaw / A2A) all describe the same thing;
    // the newer cards also call the field `protocolBinding` rather than
    // `transport`. Missing one of these silently falls through to the `/a2a`
    // guess below, which is not where the agent listens.
    const interfaces = [
      ...(card.bindings || []),
      ...(card.additionalInterfaces || []),
      ...(card.supportedInterfaces || []),
    ];
    const jsonRpc = interfaces.find((candidate) => {
      const binding = (
        candidate.transport ??
        candidate.protocolBinding ??
        ""
      ).toLowerCase();

      return binding.includes("jsonrpc") || binding === "json-rpc";
    });

    if (jsonRpc?.url) {
      return rewriteLocalhost(jsonRpc.url, base);
    }

    // Fall back to top-level url field
    if (card.url) {
      return rewriteLocalhost(card.url, base);
    }
  } catch (error) {
    logger.warn("Failed to fetch agent card, falling back to /a2a", {
      agentBaseUrl,
      error,
    });
  }

  return `${base}/a2a`;
}

/**
 * Send a Google A2A v0.3.0 message/send to a remote agent.
 * Non-blocking: returns result or error, never throws.
 */
export async function sendA2aMessage(
  endpoint: string,
  params: A2aMessageParams,
): Promise<A2aResult> {
  const parts: Array<Record<string, unknown>> = [
    { kind: "text", text: params.text },
  ];

  if (params.data) {
    parts.push({ kind: "data", data: params.data });
  }

  const body = {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "message/send",
    params: {
      message: {
        kind: "message",
        messageId: crypto.randomUUID(),
        role: "user",
        parts,
        contextId: params.contextId || `inbox-${Date.now()}`,
      },
      configuration: {
        blocking: true,
      },
    },
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  const token = env.A2A_REMOTE_AGENT_TOKEN;
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  try {
    logger.info("Sending A2A message", { endpoint, method: "message/send" });

    const response = await fetch(endpoint, {
      method: "POST",
      headers,
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

    // Older cards answer { result: { id, status } }; newer ones nest it as
    // { result: { task: { id, status } } }. Reading only the flat shape logged
    // every send as taskId/state undefined.
    const task = json.result?.task ?? json.result;
    const taskId = task?.id;
    const state = task?.status?.state;

    logger.info("A2A message sent successfully", {
      endpoint,
      taskId,
      state,
    });

    return { taskId, state };
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
): A2aMessageParams {
  return {
    text: `Urgent email from ${email.from}: ${email.subject}${email.snippet ? `\n\n${email.snippet}` : ""}`,
    data: {
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
    contextId: `inbox-${email.threadId}`,
  };
}

// Agent cards often advertise localhost URLs. Rewrite them to use the actual base URL's host.
function rewriteLocalhost(endpointUrl: string, baseUrl: string): string {
  if (!endpointUrl.startsWith("http")) {
    return `${baseUrl}${endpointUrl.startsWith("/") ? "" : "/"}${endpointUrl}`;
  }

  try {
    const endpoint = new URL(endpointUrl);
    const base = new URL(baseUrl);

    if (
      endpoint.hostname === "localhost" ||
      endpoint.hostname === "127.0.0.1"
    ) {
      endpoint.hostname = base.hostname;
      endpoint.port = base.port;
      endpoint.protocol = base.protocol;
    }

    return endpoint.toString().replace(/\/$/, "");
  } catch {
    return endpointUrl;
  }
}
