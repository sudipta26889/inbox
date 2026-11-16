import { createHash } from "node:crypto";
import { EmailSendOperationStatus } from "@/generated/prisma/enums";
import { discardDraftReplacedBySend } from "@/utils/email/compose-draft";
import { classifyEmailAccountProviderIssue } from "@/utils/email/provider-health";
import { isEmailProviderRateLimitError } from "@/utils/email/is-provider-rate-limit-error";
import type { EmailProvider } from "@/utils/email/types";
import { MAIL_MUTATION_RETRY_WINDOW_MS } from "@/utils/email/send-operation-policy";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import type { Logger } from "@/utils/logger";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { sendHtmlEmailWithOpenTracking } from "@/utils/email/sent-message-open/sent-message-open.server";
import {
  applySendEdits,
  attachmentsForCard,
  approvalFromScheduledEmail,
  approveSendOperation,
  hasSendEdits,
  htmlPreviewText,
  recallSendApproval,
  SendNotApprovedError,
  type SendApproval,
} from "@/utils/mail/send-approval";
import type { SendEmailBody } from "@/utils/types/mail";
import type { DurableEmailSendBody } from "./durable-email-send.validation";

const PROCESSING_LEASE_MS = 2 * 60 * 1000;

export async function executeDurableEmailSend({
  emailAccountId,
  getEmailProvider,
  input,
  logger,
  provider,
}: {
  emailAccountId: string;
  getEmailProvider: () => Promise<EmailProvider>;
  // A scheduled new message has no thread until the provider accepts the send.
  input: Omit<DurableEmailSendBody, "threadId"> & { threadId: string | null };
  logger: Logger;
  provider: string;
}) {
  logger = logger.with({ mutationId: input.mutationId });
  const hashPayload = (email: SendEmailBody) =>
    createHash("sha256")
      .update(
        JSON.stringify({
          threadId: input.threadId,
          messageIds: input.messageIds,
          email,
          queuedAt: input.queuedAt,
        }),
      )
      .digest("hex");
  const proposedHash = hashPayload(input.email);
  // What is committed and sent: the proposal, or the reviewer's edit of it.
  let email = input.email;
  let payloadHash = proposedHash;
  const found = await findEmailSendOperation(emailAccountId, input.mutationId);
  if (found && found.payloadHash !== proposedHash) {
    // A retry of an edited send replays the original; the stored operation is
    // the edited version the reviewer approved.
    const memo = await recallSendApproval(
      emailAccountId,
      input.mutationId,
      proposedHash,
    );
    if (memo && hasSendEdits(memo.edits)) {
      email = applySendEdits(input.email, memo.edits);
      payloadHash = hashPayload(email);
    }
  }
  if (!found && input.queuedAt < Date.now() - MAIL_MUTATION_RETRY_WINDOW_MS) {
    return {
      status: "rejected" as const,
      error: "Queued email is too old to send safely",
    };
  }
  // Approval comes before the operation is committed: a long human review
  // must not hold the processing lease, and a retry after a send record was
  // deleted must not raise a second card.
  let approval: SendApproval | undefined;
  if (!found) {
    try {
      approval =
        (await approvalFromScheduledEmail({
          emailAccountId,
          mutationId: input.mutationId,
          threadId: input.threadId,
          email,
        })) ?? undefined;
      if (!approval) {
        const approved = await approveSendOperation({
          operation: email.replyToEmail ? "reply_email" : "send_email",
          provider: provider === "google" ? "gmail" : "outlook",
          emailAccountId,
          operationId: input.mutationId,
          payloadHash,
          to: email.to,
          from: email.from,
          cc: email.cc,
          bcc: email.bcc,
          replyTo: email.replyTo,
          subject: email.subject,
          bodyText: htmlPreviewText(email.messageHtml),
          loadAttachments: () => attachmentsForCard(email, getEmailProvider),
          threadId: input.threadId ?? undefined,
          isReply: !!email.replyToEmail,
        });
        approval = approved.approval;
        if (hasSendEdits(approved.edits)) {
          email = applySendEdits(email, approved.edits);
          payloadHash = hashPayload(email);
        }
      }
    } catch (error) {
      if (!(error instanceof SendNotApprovedError)) throw error;
      logger.warn("Email send was not approved", { error });
      return { status: "rejected" as const, error: error.message };
    }
  }
  const existing = found
    ? { ...found, created: false }
    : await createEmailSendOperation({
        emailAccountId,
        mutationId: input.mutationId,
        payloadHash,
      });
  if (existing.payloadHash !== payloadHash) {
    return { status: "rejected" as const, error: "Mutation ID was reused" };
  }
  if (existing.status === EmailSendOperationStatus.SENT) {
    // A repeated dispatch retries cleanup an earlier one could not finish.
    if (input.email.replacesDraftOfSession)
      await removeReplacedDraft({
        emailAccountId,
        sessionId: input.email.replacesDraftOfSession,
        getEmailProvider,
        logger,
      });
    return { status: "already_applied" as const, result: existing.result };
  }
  if (existing.status === EmailSendOperationStatus.UNCERTAIN) {
    return { status: "uncertain" as const };
  }
  if (!existing.created) {
    const staleBefore = new Date(Date.now() - PROCESSING_LEASE_MS);
    const stale = await prisma.emailSendOperation.updateMany({
      where: {
        id: existing.id,
        status: EmailSendOperationStatus.PROCESSING,
        processingStartedAt: { lte: staleBefore },
      },
      data: { status: EmailSendOperationStatus.UNCERTAIN },
    });
    if (stale.count) logger.warn("Email send processing lease expired");
    return stale.count
      ? { status: "uncertain" as const }
      : { status: "retry" as const };
  }

  let stage: "provider_setup" | "send" | "persist_result" = "provider_setup";
  try {
    const emailProvider = await getEmailProvider();
    stage = "send";
    const result = await sendHtmlEmailWithOpenTracking({
      emailAccountId,
      threadId: input.threadId,
      email,
      emailProvider,
      logger,
      approval,
    });
    stage = "persist_result";
    await prisma.emailSendOperation.update({
      where: { id: existing.id },
      data: { result, status: EmailSendOperationStatus.SENT },
    });
    if (input.email.replacesDraftOfSession)
      await removeReplacedDraft({
        emailAccountId,
        sessionId: input.email.replacesDraftOfSession,
        getEmailProvider: async () => emailProvider,
        logger,
      });
    return { status: "applied" as const, result };
  } catch (error) {
    logger.error("Email send operation failed", { error, stage });
    if (
      stage !== "persist_result" &&
      isEmailProviderRateLimitError({ error, provider })
    ) {
      await prisma.emailSendOperation.deleteMany({
        where: { id: existing.id },
      });
      return { status: "retry" as const };
    }
    if (
      stage !== "persist_result" &&
      classifyEmailAccountProviderIssue({
        error,
        provider: provider as "google" | "microsoft",
      })
    ) {
      await prisma.emailSendOperation.deleteMany({
        where: { id: existing.id },
      });
      return { status: "blocked_auth" as const };
    }
    // Providers throw SafeError for checks that run before anything is sent,
    // so the outcome is known and the operation can be retried later.
    if (
      stage === "provider_setup" ||
      (stage === "send" && error instanceof SafeError)
    ) {
      await prisma.emailSendOperation.deleteMany({
        where: { id: existing.id },
      });
      return {
        status: "rejected" as const,
        error:
          error instanceof SafeError
            ? (error.safeMessage ?? error.message)
            : "Could not prepare the email account. Please try again.",
      };
    }
    await prisma.emailSendOperation.updateMany({
      where: { id: existing.id, status: EmailSendOperationStatus.PROCESSING },
      data: { status: EmailSendOperationStatus.UNCERTAIN },
    });
    return { status: "uncertain" as const };
  }
}

async function findEmailSendOperation(
  emailAccountId: string,
  mutationId: string,
) {
  return prisma.emailSendOperation.findUnique({
    where: {
      emailAccountId_clientMutationId: {
        emailAccountId,
        clientMutationId: mutationId,
      },
    },
  });
}

async function createEmailSendOperation({
  emailAccountId,
  mutationId,
  payloadHash,
}: {
  emailAccountId: string;
  mutationId: string;
  payloadHash: string;
}) {
  try {
    const operation = await prisma.emailSendOperation.create({
      data: {
        clientMutationId: mutationId,
        emailAccountId,
        payloadHash,
      },
    });
    return { ...operation, created: true };
  } catch (error) {
    if (!isDuplicateError(error, ["emailAccountId", "clientMutationId"])) {
      throw error;
    }
    const operation = await findEmailSendOperation(emailAccountId, mutationId);
    if (!operation) throw error;
    return { ...operation, created: false };
  }
}

// The email is out; a leftover draft must not turn that into a failure.
async function removeReplacedDraft({
  emailAccountId,
  sessionId,
  getEmailProvider,
  logger,
}: {
  emailAccountId: string;
  sessionId: string;
  getEmailProvider: () => Promise<EmailProvider>;
  logger: Logger;
}) {
  try {
    await discardDraftReplacedBySend({
      emailAccountId,
      sessionId,
      provider: await getEmailProvider(),
    });
  } catch (error) {
    logger.warn("Could not remove the draft a send replaced", { error });
  }
}
