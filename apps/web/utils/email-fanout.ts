import { env } from "@/env";
import { SystemType } from "@/generated/prisma/enums";
import {
  getRemoteAgentUrls,
  resolveA2aEndpoint,
  sendA2aMessage,
} from "@/utils/a2a-client";
import type { Logger } from "@/utils/logger";
import { sliceHead } from "@/utils/string";
import type { ParsedMessage } from "@/utils/types";

// Mirrors Slack-Agent's per-notification fan-out: every email that isn't noise
// goes to Mitra (A2A) and MeetEcho's PKM, carrying the analysis Inbox already
// made. No extra LLM call — the shared gateway is at capacity.

// What Slack-Agent calls relevance=noise: bulk or automated mail.
const NOISE_TYPES = new Set<string>([
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
  SystemType.RECEIPT,
  SystemType.NOTIFICATION,
  SystemType.COLD_EMAIL,
]);
const EXCERPT_LENGTH = 1500;
const MEETECHO_TIMEOUT_MS = 15_000;

export type EmailAnalysisRule = {
  name: string;
  systemType?: string | null;
  reason?: string | null;
};

export function fanOutEmailAnalysis({
  message,
  accountEmail,
  rules,
  skippedReason,
  mitraAlreadyNotified,
  logger,
}: {
  message: ParsedMessage;
  accountEmail: string;
  rules: EmailAnalysisRule[];
  // Set when no rule matched: the email is still relevant, just unclassified.
  skippedReason?: string;
  // A rule's own A2A_NOTIFY action already sent this email to Mitra.
  mitraAlreadyNotified: boolean;
  logger: Logger;
}) {
  if (!isRelevant(rules)) return;

  const analysis = describeAnalysis(rules, skippedReason);
  const log = logger.with({ module: "email-fanout" });

  if (env.A2A_FANOUT_ALL_EMAILS === "true" && !mitraAlreadyNotified) {
    sendToMitra({ message, accountEmail, rules, analysis }).catch((error) =>
      log.warn("Mitra fan-out failed", { error }),
    );
  }
  if (env.MEETECHO_INBOX_INGEST_URL && env.MEETECHO_A2A_TOKEN) {
    sendToMeetEcho({
      url: env.MEETECHO_INBOX_INGEST_URL,
      token: env.MEETECHO_A2A_TOKEN,
      message,
      accountEmail,
      rules,
      analysis,
    })
      .then((status) => log.info("MeetEcho fan-out", { status }))
      .catch((error) => log.warn("MeetEcho fan-out failed", { error }));
  }
}

export function isRelevant(rules: EmailAnalysisRule[]) {
  return !rules.some(
    (rule) => rule.systemType && NOISE_TYPES.has(rule.systemType),
  );
}

function describeAnalysis(rules: EmailAnalysisRule[], skippedReason?: string) {
  if (!rules.length) {
    return `Inbox analysis: no rule matched${skippedReason ? ` (${skippedReason})` : ""}.`;
  }
  const lines = rules.map(
    (rule) => `- ${rule.name}${rule.reason ? `: ${rule.reason}` : ""}`,
  );
  return `Inbox analysis:\n${lines.join("\n")}`;
}

async function sendToMitra({
  message,
  accountEmail,
  rules,
  analysis,
}: {
  message: ParsedMessage;
  accountEmail: string;
  rules: EmailAnalysisRule[];
  analysis: string;
}) {
  const text = [
    `New email in ${accountEmail} from ${message.headers.from}${message.headers.to ? ` to ${message.headers.to}` : ""}, received ${receivedAt(message)}:`,
    `Subject: ${message.headers.subject ?? ""}`,
    `Excerpt: ${excerpt(message)}`,
    analysis,
    "Please provide any additional context or actions related to this email.",
  ].join("\n");

  await Promise.allSettled(
    getRemoteAgentUrls().map(async (agentUrl) =>
      sendA2aMessage(await resolveA2aEndpoint(agentUrl), {
        text,
        data: {
          source: "inbox",
          messageId: message.id,
          threadId: message.threadId,
          rules: rules.map((rule) => rule.name),
        },
        contextId: `inbox-${message.threadId}`,
      }),
    ),
  );
}

async function sendToMeetEcho({
  url,
  token,
  message,
  accountEmail,
  rules,
  analysis,
}: {
  url: string;
  token: string;
  message: ParsedMessage;
  accountEmail: string;
  rules: EmailAnalysisRule[];
  analysis: string;
}) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      message_id: message.id,
      thread_id: message.threadId,
      from: message.headers.from,
      subject: message.headers.subject,
      // MeetEcho renders only from/subject/snippet/labels, so the analysis
      // leads the snippet.
      snippet: `${analysis}\n\n${excerpt(message)}`,
      received_at: receivedAt(message),
      labels: rules.map((rule) => rule.name),
      account: accountEmail,
      // Always reference: "action" also makes MeetEcho create a TaskPilot work
      // item, and Inbox already routes actionable mail to TaskPilot itself.
      intent: "reference",
    }),
    signal: AbortSignal.timeout(MEETECHO_TIMEOUT_MS),
  });
  return response.status;
}

function excerpt(message: ParsedMessage) {
  return sliceHead(
    (message.textPlain || message.snippet || "").trim(),
    EXCERPT_LENGTH,
  );
}

function receivedAt(message: ParsedMessage) {
  return new Date(Number(message.internalDate) || Date.now()).toISOString();
}
