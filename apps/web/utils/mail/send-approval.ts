import "server-only";
import { dharahilClient } from "@/utils/dharahil/client";
import { createScopedLogger } from "@/utils/logger";
import { isApprovalGateRequired } from "@/utils/dharahil/required";

const logger = createScopedLogger("send-approval");

/**
 * The single approval gate every outbound send must pass.
 *
 * This exists as one choke point rather than an `if` at each call site because
 * the per-site version already failed: `sendEmailWithHtml` carried the gate and
 * a comment claiming it covered "ALL email sends", while `replyToEmail`,
 * `forwardEmail` and `sendDraft` were added later calling the provider send API
 * directly, with no gate at all. A rule action could reply or forward with no
 * human anywhere in the loop.
 *
 * Adding a new send path without calling this is now a visible omission rather
 * than a silent one — there is no second copy of the logic to drift from.
 */
export type SendApprovalRequest = {
  /** Operation name shown to the reviewer, e.g. "send_email", "reply_email". */
  operation: string;
  provider: "gmail" | "outlook";
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Plain-text body; only a preview is forwarded to the reviewer. */
  bodyText?: string;
  threadId?: string;
  isReply?: boolean;
};

const BODY_PREVIEW_CHARS = 500;

export async function requireSendApproval(
  request: SendApprovalRequest,
): Promise<void> {
  if (!isApprovalGateRequired()) return;

  const { operation, provider, to, subject } = request;

  logger.info("DharaHIL: requesting approval for outbound send", {
    operation,
    provider,
    to,
    subject,
  });

  const external = isExternalDomain(to);

  const decision = await dharahilClient.runApprovalLoop({
    toolName: operation,
    toolArgs: {
      to,
      from: request.from,
      cc: request.cc,
      bcc: request.bcc,
      subject,
      body: request.bodyText?.substring(0, BODY_PREVIEW_CHARS),
      isReply: !!request.isReply,
    },
    context: {
      agentId: `inbox-${provider}-provider`,
      runId: request.threadId || `${operation}_${Date.now()}`,
      stepId: operation,
      contextSummary: `${operation} to ${to}${subject ? ` - Subject: ${subject}` : ""}`,
      riskLevel: external ? "HIGH" : "MEDIUM",
      tags: ["email", provider, operation, external ? "external" : "internal"],
      idempotencyKey: `${provider}_${operation}_${to}_${Date.now()}`,
      metadata: {
        provider,
        operation,
        to,
        subject: subject ?? "",
        is_reply: request.isReply ? "true" : "false",
      },
    },
  });

  if (dharahilClient.wasDenied(decision)) {
    throw new Error(
      `Email sending denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`,
    );
  }

  if (dharahilClient.shouldRevise(decision)) {
    throw new Error(
      `Email revision requested: ${decision.revise_input || "No specific instructions provided"}`,
    );
  }

  logger.info("DharaHIL: outbound send approved", {
    operation,
    to,
    action: decision.action,
  });
}

/**
 * Domains treated as internal for risk scoring. Moved here from
 * utils/gmail/mail.ts so both providers score the same way.
 */
const INTERNAL_DOMAINS = ["sudiptadhara.in", "localhost"];

export function isExternalDomain(email: string): boolean {
  const domain = email.split("@")[1]?.toLowerCase();

  return !INTERNAL_DOMAINS.some((internal) => domain?.includes(internal));
}
