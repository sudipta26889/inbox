import "server-only";
import { createHash } from "node:crypto";
import { type DharaHILDecision, dharahilClient } from "@/utils/dharahil/client";
import { createScopedLogger } from "@/utils/logger";
import { isApprovalGateRequired } from "@/utils/dharahil/required";
import { extractEmailAddress, extractEmailAddresses } from "@/utils/email";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { textToHtmlParagraphs } from "@/utils/string";
import {
  cardBodyFromHtml,
  rebuildHtmlWithEditedBody,
} from "@/utils/mail/card-body";
import { scheduleEmailBody } from "@/utils/actions/scheduled-email.validation";
import { MAIL_MUTATION_RETRY_WINDOW_MS } from "@/utils/email/send-operation-policy";
import type { SendEmailBody } from "@/utils/types/mail";
import type { EmailProvider } from "@/utils/email/types";

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
  replyTo?: string;
  subject?: string;
  /** Plain-text body, shown in full so the reviewer approves what is sent. */
  bodyText?: string;
  /**
   * The HTML that will be sent. Takes precedence over bodyText: the card shows
   * the authored part as Markdown and keeps the signature and quote intact.
   */
  bodyHtml?: string;
  /** Files this send carries (payload or mailbox draft). */
  attachments?: AttachmentInfo[];
  /** Files a forward copies from its (immutable) source message. */
  forwardedAttachments?: AttachmentInfo[];
  threadId?: string;
  isReply?: boolean;
  /** When a scheduled email goes out, so the reviewer approves the time too. */
  sendAt?: string;
  /**
   * Durable id of the operation. With the content hash it becomes the
   * gateway's idempotency key, so a retry while the card is open joins that
   * card instead of raising a second one.
   */
  operationId?: string;
  /** Proof this exact send was approved before it was committed. */
  approval?: SendApproval;
};

export type AttachmentInfo = { filename: string; size?: number };

/**
 * What the reviewer changed on the card. Only recipients, subject and body
 * can change; the caller sends with these values instead of its own.
 */
export type SendEdits = {
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText?: string;
  /** The full HTML to send: edited body, original signature and quote. */
  bodyHtml?: string;
};

/**
 * Proof that a human approved one operation before it was committed (or that
 * no gate is configured). Only this module creates one, and it is checked by
 * object identity, so no request body, tool argument or JSON payload can forge
 * it: there is no bypass flag to set. It is bound to the recipients, subject
 * and attachments that were approved, so it cannot carry a different email.
 */
export type SendApproval = {
  readonly emailAccountId: string;
  readonly operationId: string;
  readonly fingerprint: string;
};

/** What a provider send function needs to call the gate. */
export type SendGate = {
  emailAccountId?: string;
  approval?: SendApproval;
  /** Stable id for sends with no durable operation, such as rule actions. */
  operationId?: string;
};

/** A human said no, or the gate could not ask. Nothing was sent. */
export class SendNotApprovedError extends SafeError {}

const issuedApprovals = new WeakSet<SendApproval>();

// The gateway has no size limit on tool args; this only bounds a pathological
// payload. Above it the card shows a preview and refuses body edits.
const CARD_BODY_MAX_CHARS = 100_000;
// The gateway rejects metadata values over 500 characters.
const METADATA_VALUE_MAX_CHARS = 500;
const EDITABLE_FIELDS = ["to", "cc", "bcc", "subject", "body"] as const;

export async function requireSendApproval(
  request: SendApprovalRequest,
): Promise<SendEdits> {
  if (!gateRequired()) return {};

  if (isIssuedApproval(request.approval, request.emailAccountId)) {
    if (request.approval.fingerprint === sendFingerprint(request)) {
      logger.info("DharaHIL: send was approved before it was committed", {
        operation: request.operation,
        operationId: request.approval.operationId,
      });
      return {};
    }
    logger.warn("DharaHIL: approved send changed before it went out; asking", {
      operation: request.operation,
      operationId: request.approval.operationId,
    });
  }

  return askReviewer(request);
}

/**
 * Asks once per operation, before the operation or schedule is committed.
 *
 * The decision (and any edits) is remembered against the operation id and the
 * payload hash, so a retry of the same approved operation (after a provider
 * error deleted its send record, say) sends the approved version with no
 * second card. The same id carrying a different email asks again once the
 * first card is resolved; while it is still open the gateway refuses the
 * second one (409), which is reported as "approval unavailable".
 */
export async function approveSendOperation({
  payloadHash,
  loadAttachments,
  ...request
}: SendApprovalRequest & {
  emailAccountId: string;
  operationId: string;
  payloadHash: string;
  /** Reads the files for the card, only when a card is actually raised. */
  loadAttachments?: () => Promise<{
    attachments: AttachmentInfo[];
    forwardedAttachments?: AttachmentInfo[];
  }>;
}): Promise<{
  approval: SendApproval;
  edits: SendEdits;
  attachments: AttachmentInfo[];
}> {
  const approve = (edits: SendEdits, attachments: AttachmentInfo[]) => ({
    approval: issueApproval(
      request.emailAccountId,
      request.operationId,
      sendFingerprint({ ...request, ...edits, attachments }),
    ),
    edits,
    attachments,
  });
  if (!gateRequired()) return approve({}, request.attachments ?? []);

  const remembered = await recallSendApproval(
    request.emailAccountId,
    request.operationId,
    payloadHash,
  );
  if (remembered) {
    logger.info("DharaHIL: operation already approved", {
      operation: request.operation,
      operationId: request.operationId,
    });
    return approve(remembered.edits, remembered.attachments);
  }

  const files = loadAttachments ? await loadAttachments() : {};
  const full = { ...request, ...files };
  const edits = await askReviewer(full);
  const attachments = full.attachments ?? [];
  await rememberApproval(
    approvalMemoKey(request.emailAccountId, request.operationId, payloadHash),
    { edits, attachments },
  );
  return approve(edits, attachments);
}

/** The edits a remembered approval carried, or null if none is remembered. */
export async function recallSendApproval(
  emailAccountId: string,
  operationId: string,
  payloadHash: string,
): Promise<ApprovalMemo | null> {
  if (!gateRequired()) return null;
  try {
    const value = await redis.get<ApprovalMemo | string>(
      approvalMemoKey(emailAccountId, operationId, payloadHash),
    );
    if (value === null || value === undefined) return null;
    const memo = typeof value === "string" ? JSON.parse(value) : value;
    return { edits: memo.edits ?? {}, attachments: memo.attachments ?? [] };
  } catch (error) {
    // A lost memo costs one extra card, never a skipped one.
    logger.warn("Could not read the approval memo; asking again", { error });
    return null;
  }
}

/**
 * Records an approval under a second payload hash, so the edited payload that
 * was stored can find it too.
 */
export async function rememberApprovedPayload(
  emailAccountId: string,
  operationId: string,
  payloadHash: string,
  memo: ApprovalMemo,
) {
  await rememberApproval(
    approvalMemoKey(emailAccountId, operationId, payloadHash),
    memo,
  );
}

/**
 * A scheduled or undo-held email was approved when it was scheduled, and its
 * row stores the exact payload the human approved. Sending that payload needs
 * no second card at send time, so nobody is asked at 3 am.
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
  email: SendEmailBody;
}): Promise<SendApproval | null> {
  const row = await prisma.scheduledEmail.findUnique({
    where: {
      emailAccountId_clientMutationId: {
        emailAccountId,
        clientMutationId: mutationId,
      },
    },
    select: { status: true, payload: true, threadId: true, payloadHash: true },
  });
  if (row?.status !== "PROCESSING") return null;

  const scheduled = scheduleEmailBody.safeParse(row.payload);
  if (!scheduled.success) return null;
  if (row.threadId !== threadId) return null;
  if (JSON.stringify(scheduled.data.email) !== JSON.stringify(email))
    return null;

  // A draft's files are not in the payload; the memo holds the approved list.
  const memo = await recallSendApproval(
    emailAccountId,
    mutationId,
    row.payloadHash,
  );
  return issueApproval(
    emailAccountId,
    mutationId,
    sendFingerprint({
      ...email,
      attachments: memo?.attachments.length
        ? memo.attachments
        : payloadAttachments(email),
    }),
  );
}

/** The email with the reviewer's edits applied. */
export function applySendEdits<
  T extends {
    to: string;
    cc?: string;
    bcc?: string;
    subject: string;
    messageHtml: string;
  },
>(email: T, edits: SendEdits): T {
  return {
    ...email,
    ...(edits.to !== undefined && { to: edits.to }),
    ...(edits.cc !== undefined && { cc: edits.cc }),
    ...(edits.bcc !== undefined && { bcc: edits.bcc }),
    ...(edits.subject !== undefined && { subject: edits.subject }),
    ...(editedHtml(edits) !== undefined && {
      messageHtml: editedHtml(edits),
    }),
  };
}

export function hasSendEdits(edits: SendEdits) {
  return Object.keys(edits).length > 0;
}

export function payloadAttachments(email: SendEmailBody): AttachmentInfo[] {
  return (email.attachments ?? []).map((attachment) => ({
    filename: attachment.filename,
    size: attachment.size,
  }));
}

export type DraftSnapshot = {
  to: string;
  from?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  attachments: AttachmentInfo[];
  threadId?: string;
};

/**
 * Gate a mailbox-draft send, which sends whatever the draft holds when the
 * provider is called, not what the card showed.
 *
 * The draft is read for the card, read again after the decision, and refused
 * if anything changed in between (the user, an AI refresh or an MCP edit may
 * touch it while the card is open). Edits from the card are written to the
 * draft before it is sent; its files go out unchanged.
 */
export async function approveDraftSend({
  provider,
  gate,
  read,
  update,
}: {
  provider: "gmail" | "outlook";
  gate: SendGate;
  read: () => Promise<DraftSnapshot>;
  update?: (changes: {
    to?: string;
    cc?: string;
    bcc?: string;
    subject?: string;
    messageHtml?: string;
  }) => Promise<void>;
}): Promise<DraftSnapshot | null> {
  // No gate, no extra draft reads: the send behaves exactly as before.
  if (!gateRequired()) return null;
  const before = await read();
  const edits = await requireSendApproval({
    operation: "send_draft",
    provider,
    ...gate,
    ...before,
  });
  const after = await read();
  if (hashOf(after) !== hashOf(before))
    throw new SendNotApprovedError(
      "Email not sent: the draft changed while it was waiting for approval. Send it again to approve the new version.",
    );

  if (!hasSendEdits(edits)) return before;
  if (!update)
    throw new SendNotApprovedError(
      "Email not sent: this draft can't take edits from the approval card. Edit it in Inbox and send it again.",
    );
  await update({
    to: edits.to,
    cc: edits.cc,
    bcc: edits.bcc,
    subject: edits.subject,
    messageHtml: editedHtml(edits),
  });
  return before;
}

/**
 * Recipients, subject and attachment names: what an approval is bound to.
 *
 * ponytail: the body is not part of it, because the provider sees it in a
 * different form (open-tracking pixel, draft rewrite). The durable payload
 * hash and the stored schedule row bind the body instead.
 */
export function sendFingerprint(request: {
  to: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  attachments?: AttachmentInfo[];
}) {
  const addresses = (value?: string) =>
    extractEmailAddresses(value ?? "")
      .map((address) => address.toLowerCase())
      .sort();
  return hashOf([
    addresses(request.to),
    addresses(request.cc),
    addresses(request.bcc),
    (request.subject ?? "").trim(),
    (request.attachments ?? []).map((file) => file.filename).sort(),
  ]);
}

async function askReviewer(request: SendApprovalRequest): Promise<SendEdits> {
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
  const card =
    request.bodyHtml !== undefined
      ? cardBodyFromHtml(request.bodyHtml)
      : { body: request.bodyText ?? "" };
  // The cap counts only what the user wrote, not the signature or quote.
  const body = card.body;
  const bodyTruncated = body.length > CARD_BODY_MAX_CHARS;

  const toolArgs = {
    from,
    mailbox: sendsAsAlias ? mailboxEmail : undefined,
    to,
    cc: request.cc,
    bcc: request.bcc,
    replyTo: request.replyTo,
    subject,
    body: bodyTruncated
      ? `[preview: full body is ${body.length} characters; body edits are disabled]\n\n${body.slice(0, CARD_BODY_MAX_CHARS)}`
      : body,
    ...(bodyTruncated && { bodyTruncated: true, bodyLength: body.length }),
    ...(card.signature && { signature: card.signature }),
    ...(card.quotedHistory && { quoted_history: card.quotedHistory }),
    ...(request.attachments?.length && { attachments: request.attachments }),
    ...(request.forwardedAttachments?.length && {
      forwardedAttachments: request.forwardedAttachments,
    }),
    isReply: !!request.isReply,
    ...(request.sendAt && { sendAt: request.sendAt }),
  };
  // Content goes into the key, so two different emails never share a card.
  const contentHash = hashOf(toolArgs);

  const decision = await dharahilClient.runApprovalLoop({
    toolName: operation,
    toolArgs,
    context: {
      agentId: `inbox-${provider}-provider`,
      runId:
        request.operationId || request.threadId || `${operation}_${Date.now()}`,
      stepId: operation,
      contextSummary: `${operation} from ${from} to ${to}${subject ? ` - Subject: ${subject}` : ""}${request.sendAt ? ` - at ${request.sendAt}` : ""}`,
      riskLevel: external ? "HIGH" : "MEDIUM",
      tags: ["email", provider, operation, external ? "external" : "internal"],
      idempotencyKey: request.operationId
        ? `inbox_${request.emailAccountId}_${request.operationId}_${contentHash}`
        : `${provider}_${operation}_${contentHash}_${Date.now()}`,
      metadata: boundedMetadata({
        provider,
        operation,
        from,
        to,
        subject: subject ?? "",
        is_reply: request.isReply ? "true" : "false",
      }),
    },
  });

  if (!dharahilClient.shouldProceed(decision)) {
    throw new SendNotApprovedError(notApprovedMessage(decision));
  }

  const { bodyHtml } = request;
  const edits = editsFrom(
    toolArgs,
    decision,
    bodyTruncated,
    bodyHtml === undefined
      ? undefined
      : (markdown) => rebuildHtmlWithEditedBody(bodyHtml, markdown),
  );

  logger.info("DharaHIL: outbound send approved", {
    operation,
    action: decision.action,
    edited: Object.keys(edits),
  });
  return edits;
}

function editsFrom(
  proposed: Record<string, unknown>,
  decision: DharaHILDecision,
  bodyTruncated: boolean,
  /** Turns the edited Markdown back into the full HTML, for HTML cards. */
  rebuildHtml?: (markdown: string) => string,
): SendEdits {
  const approved = decision.approvedArgs;
  if (!approved) return {};

  // The gateway stores args as JSONB, which reorders object keys, so values
  // are compared structurally: key order ignored, array order kept.
  const changed = (key: string) =>
    canonicalJson(approved[key]) !== canonicalJson(proposed[key]);

  if (changed("from") || changed("mailbox"))
    throw new SendNotApprovedError(
      "Email not sent: the sender can't be changed on the approval card.",
    );
  if (changed("signature") || changed("quoted_history"))
    throw new SendNotApprovedError(
      "Email not sent: the signature and quoted messages can't be edited on the card.",
    );
  const other = Object.keys({ ...proposed, ...approved }).filter(
    (key) =>
      !(EDITABLE_FIELDS as readonly string[]).includes(key) &&
      key !== "from" &&
      key !== "mailbox" &&
      changed(key),
  );
  if (other.length)
    throw new SendNotApprovedError(
      `Email not sent: only recipients, subject and body can be edited on the approval card (changed: ${other.join(", ")}).`,
    );
  if (bodyTruncated && changed("body"))
    throw new SendNotApprovedError(
      "Email not sent: the body is too long to edit on the card. Edit it in Inbox and send it again.",
    );

  const edits: SendEdits = {};
  for (const key of EDITABLE_FIELDS) {
    if (!changed(key)) continue;
    const value = approved[key];
    if (value !== undefined && value !== null && typeof value !== "string")
      throw new SendNotApprovedError(
        `Email not sent: the edited ${key} is not text.`,
      );
    const text = typeof value === "string" ? value : "";
    if (key !== "body") edits[key] = text;
    else if (rebuildHtml) edits.bodyHtml = rebuildHtml(text);
    else edits.bodyText = text;
  }
  // An edited recipient list that parses to nothing must never fall back to
  // the original recipients. An emptied cc/bcc is a deliberate removal.
  for (const key of ["to", "cc", "bcc"] as const) {
    const value = edits[key];
    if (value === undefined) continue;
    if (key !== "to" && value.trim() === "") continue;
    if (!extractEmailAddresses(value).length)
      throw new SendNotApprovedError(
        `Email not sent: the edited ${key} has no valid email address.`,
      );
  }
  return edits;
}

function editedHtml(edits: SendEdits) {
  if (edits.bodyHtml !== undefined) return edits.bodyHtml;
  if (edits.bodyText !== undefined) return textToHtmlParagraphs(edits.bodyText);
}

function notApprovedMessage(decision: DharaHILDecision) {
  switch (decision.action) {
    case "REJECTED":
    case "DENY":
      return `Email sending denied by human reviewer${decision.reason ? `: ${decision.reason}` : ""}`;
    case "REVISE_REQUESTED":
      return `Email revision requested: ${decision.revise_input || "No specific instructions provided"}`;
    case "EXPIRED":
      return "Email not sent: nobody approved it before the request expired.";
    default:
      return "Email not sent: the approval service is unavailable. Nothing was sent; try again.";
  }
}

/** True when sends are gated; throws when production is misconfigured. */
export function isSendGateOn() {
  return gateRequired();
}

function gateRequired() {
  try {
    return isApprovalGateRequired();
  } catch (error) {
    throw new SendNotApprovedError(
      error instanceof Error ? error.message : "Approval is not configured.",
    );
  }
}

function issueApproval(
  emailAccountId: string,
  operationId: string,
  fingerprint: string,
): SendApproval {
  const approval = Object.freeze({ emailAccountId, operationId, fingerprint });
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

type ApprovalMemo = { edits: SendEdits; attachments: AttachmentInfo[] };

function approvalMemoKey(
  emailAccountId: string,
  operationId: string,
  payloadHash: string,
) {
  return `send-approval:${emailAccountId}:${operationId}:${payloadHash}`;
}

async function rememberApproval(key: string, memo: ApprovalMemo) {
  try {
    await redis.set(key, JSON.stringify(memo), {
      ex: Math.ceil(MAIL_MUTATION_RETRY_WINDOW_MS / 1000),
    });
  } catch (error) {
    logger.warn("Could not store the approval memo", { error });
  }
}

function boundedMetadata(metadata: Record<string, string>) {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      value.slice(0, METADATA_VALUE_MAX_CHARS),
    ]),
  );
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== undefined && entry !== null)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  return value;
}

function hashOf(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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

/**
 * The files the card must name. A compose send's files live on its mailbox
 * draft, not in the payload; a forward copies its source message's files.
 */
export async function attachmentsForCard(
  email: SendEmailBody,
  getEmailProvider: () => Promise<EmailProvider>,
): Promise<{
  attachments: AttachmentInfo[];
  forwardedAttachments?: AttachmentInfo[];
}> {
  try {
    const draft = email.providerDraftId
      ? await (await getEmailProvider()).getDraftAttachments(
          email.providerDraftId,
        )
      : null;
    const forwardedMessageId = email.replyToEmail?.forwardedMessageId;
    const forwarded = forwardedMessageId
      ? await (await getEmailProvider()).getMessage(forwardedMessageId)
      : null;
    return {
      attachments: [
        ...payloadAttachments(email),
        ...(draft?.attachments ?? []).map(({ filename, size }) => ({
          filename,
          size,
        })),
      ],
      ...(forwarded && {
        forwardedAttachments: (forwarded.attachments ?? []).map(
          ({ filename, size }) => ({ filename, size }),
        ),
      }),
    };
  } catch {
    // The reviewer must see the files; without them there is no card.
    throw new SendNotApprovedError(
      "Email not sent: its attachments could not be read for approval. Try again.",
    );
  }
}
