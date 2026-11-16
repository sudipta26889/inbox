import "server-only";
import { dharahilClient } from "@/utils/dharahil/client";
import { createScopedLogger } from "@/utils/logger";
import { isApprovalGateRequired } from "@/utils/dharahil/required";
import { extractEmailAddress } from "@/utils/email";
import { convertOutgoingEmailHtmlToText } from "@/utils/mail";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { scheduleEmailBody } from "@/utils/actions/scheduled-email.validation";
import { MAIL_MUTATION_RETRY_WINDOW_MS } from "@/utils/email/send-operation-policy";

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
  /** Looked up from the account when the caller does not know it. */
  provider?: "gmail" | "outlook";
  /** Mailbox the send goes out of; the reviewer is shown its address. */
  emailAccountId?: string;
  to: string;
  /** Explicit sender (an alias); defaults to the mailbox address. */
  from?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  /** Plain-text body; only a preview is forwarded to the reviewer. */
  bodyText?: string;
  threadId?: string;
  isReply?: boolean;
  /** When a scheduled email goes out, so the reviewer approves the time too. */
  sendAt?: string;
  /**
   * Durable id of the operation. It becomes the gateway's idempotency key, so
   * a retry while the card is still open joins that card instead of raising a
   * second one.
   */
  operationId?: string;
  /** Proof this exact send was approved before it was committed. */
  approval?: SendApproval;
};

/**
 * Proof that a human approved one operation before it was committed (or that
 * no gate is configured). Only this module creates one, and it is checked by
 * object identity, so no request body, tool argument or JSON payload can forge
 * it: there is no bypass flag to set.
 */
export type SendApproval = {
  readonly emailAccountId: string;
  readonly operationId: string;
};

/** What a provider send function needs to call the gate. */
export type SendGate = {
  emailAccountId?: string;
  approval?: SendApproval;
};

/** A human said no (or the gate could not ask). Nothing was sent. */
export class SendNotApprovedError extends SafeError {}

const issuedApprovals = new WeakSet<SendApproval>();

const BODY_PREVIEW_CHARS = 500;

export async function requireSendApproval(
  request: SendApprovalRequest,
): Promise<void> {
  if (!isApprovalGateRequired()) return;

  if (isIssuedApproval(request.approval, request.emailAccountId)) {
    logger.info("DharaHIL: send was approved before it was committed", {
      operation: request.operation,
      operationId: request.approval.operationId,
    });
    return;
  }

  await askReviewer(request);
}

/**
 * Asks once per operation, before the operation or schedule is committed.
 *
 * The decision is remembered against the operation id and the payload hash, so
 * a retry of the same approved operation (after a provider error deleted its
 * send record, say) sends with no second card, while the same id carrying a
 * different email asks again.
 */
export async function approveSendOperation({
  payloadHash,
  ...request
}: SendApprovalRequest & {
  emailAccountId: string;
  operationId: string;
  payloadHash: string;
}): Promise<SendApproval> {
  const approval = issueApproval(request.emailAccountId, request.operationId);
  if (!isApprovalGateRequired()) return approval;

  const key = approvalMemoKey(
    request.emailAccountId,
    request.operationId,
    payloadHash,
  );
  if (await wasApproved(key)) {
    logger.info("DharaHIL: operation already approved", {
      operation: request.operation,
      operationId: request.operationId,
    });
    return approval;
  }

  await askReviewer(request);
  await rememberApproval(key);
  return approval;
}

/**
 * A scheduled or undo-held email was approved when it was scheduled, and its
 * row stores the exact payload the human saw. Sending that payload needs no
 * second card at send time, so nobody is asked at 3 am.
 *
 * Only a row that is being sent right now and carries this exact email
 * counts, so a direct send that reuses a scheduled email's id with different
 * content is still asked.
 */
export async function approvalFromScheduledEmail({
  emailAccountId,
  mutationId,
  threadId,
  email,
}: {
  emailAccountId: string;
  mutationId: string;
  threadId: string | null;
  email: unknown;
}): Promise<SendApproval | null> {
  const row = await prisma.scheduledEmail.findUnique({
    where: {
      emailAccountId_clientMutationId: {
        emailAccountId,
        clientMutationId: mutationId,
      },
    },
    select: { status: true, payload: true, threadId: true },
  });
  if (row?.status !== "PROCESSING") return null;

  const scheduled = scheduleEmailBody.safeParse(row.payload);
  if (!scheduled.success) return null;
  if (row.threadId !== threadId) return null;
  if (JSON.stringify(scheduled.data.email) !== JSON.stringify(email))
    return null;

  return issueApproval(emailAccountId, mutationId);
}

export function htmlPreviewText(html: string): string | undefined {
  try {
    return convertOutgoingEmailHtmlToText(html);
  } catch {
    return;
  }
}

async function askReviewer(request: SendApprovalRequest): Promise<void> {
  const { operation, to, subject } = request;

  const mailbox = await getMailbox(request.emailAccountId);
  const mailboxEmail = mailbox?.email ?? null;
  const provider = request.provider ?? mailbox?.provider ?? "unknown";
  const from = request.from ?? mailboxEmail ?? "unknown";
  const sendsAsAlias =
    !!request.from &&
    !!mailboxEmail &&
    extractEmailAddress(request.from).toLowerCase() !==
      mailboxEmail.toLowerCase();

  logger.info("DharaHIL: requesting approval for outbound send", {
    operation,
    provider,
    operationId: request.operationId,
  });
  logger.trace("DharaHIL: send details", { to, subject });

  const external = isExternalDomain(to);

  const decision = await dharahilClient.runApprovalLoop({
    toolName: operation,
    toolArgs: {
      from,
      mailbox: sendsAsAlias ? mailboxEmail : undefined,
      to,
      cc: request.cc,
      bcc: request.bcc,
      subject,
      body: request.bodyText?.slice(0, BODY_PREVIEW_CHARS),
      isReply: !!request.isReply,
      ...(request.sendAt && { sendAt: request.sendAt }),
    },
    context: {
      agentId: `inbox-${provider}-provider`,
      runId:
        request.operationId || request.threadId || `${operation}_${Date.now()}`,
      stepId: operation,
      contextSummary: `${operation} from ${from} to ${to}${subject ? ` - Subject: ${subject}` : ""}${request.sendAt ? ` - at ${request.sendAt}` : ""}`,
      riskLevel: external ? "HIGH" : "MEDIUM",
      tags: ["email", provider, operation, external ? "external" : "internal"],
      idempotencyKey: request.operationId
        ? `inbox_${request.emailAccountId}_${request.operationId}`
        : `${provider}_${operation}_${to}_${Date.now()}`,
      metadata: {
        provider,
        operation,
        from,
        to,
        subject: subject ?? "",
        is_reply: request.isReply ? "true" : "false",
      },
    },
  });

  if (dharahilClient.wasDenied(decision)) {
    throw new SendNotApprovedError(
      `Email sending denied by human reviewer: ${decision.action}${decision.reason ? ` - ${decision.reason}` : ""}`,
    );
  }

  if (dharahilClient.shouldRevise(decision)) {
    throw new SendNotApprovedError(
      `Email revision requested: ${decision.revise_input || "No specific instructions provided"}`,
    );
  }

  logger.info("DharaHIL: outbound send approved", {
    operation,
    action: decision.action,
  });
}

function issueApproval(
  emailAccountId: string,
  operationId: string,
): SendApproval {
  const approval = Object.freeze({ emailAccountId, operationId });
  issuedApprovals.add(approval);
  return approval;
}

function isIssuedApproval(
  approval: SendApproval | undefined,
  emailAccountId: string | undefined,
): approval is SendApproval {
  return (
    !!approval &&
    issuedApprovals.has(approval) &&
    approval.emailAccountId === emailAccountId
  );
}

function approvalMemoKey(
  emailAccountId: string,
  operationId: string,
  payloadHash: string,
) {
  return `send-approval:${emailAccountId}:${operationId}:${payloadHash}`;
}

// A lost memo costs one extra card, never a skipped one, so a Redis failure
// falls back to asking.
async function wasApproved(key: string): Promise<boolean> {
  try {
    return (await redis.get(key)) !== null;
  } catch (error) {
    logger.warn("Could not read the approval memo; asking again", { error });
    return false;
  }
}

async function rememberApproval(key: string) {
  try {
    await redis.set(key, "1", {
      ex: Math.ceil(MAIL_MUTATION_RETRY_WINDOW_MS / 1000),
    });
  } catch (error) {
    logger.warn("Could not store the approval memo", { error });
  }
}

// A failed lookup must not skip the gate: the reviewer is still asked, just
// without a sender they can verify.
async function getMailbox(
  emailAccountId: string | undefined,
): Promise<{ email: string; provider: "gmail" | "outlook" } | null> {
  if (!emailAccountId) return null;
  try {
    const account = await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { email: true, account: { select: { provider: true } } },
    });
    if (!account) return null;
    return {
      email: account.email,
      provider: account.account?.provider === "google" ? "gmail" : "outlook",
    };
  } catch (error) {
    logger.warn("Could not look up the sending mailbox for approval", {
      emailAccountId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
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
