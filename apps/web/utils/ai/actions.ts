import type { Prisma } from "@/generated/prisma/client";
import { after } from "next/server";
import { ActionType } from "@/generated/prisma/enums";
import type { ExecutedRule } from "@/generated/prisma/client";
import type { Logger } from "@/utils/logger";
import { callWebhook } from "@/utils/webhook";
import type { ActionItem, EmailForAction } from "@/utils/ai/types";
import type { EmailProvider } from "@/utils/email/types";
import { enqueueDigestItem } from "@/utils/digest/index";
import { filterNullProperties } from "@/utils";
import { labelMessageAndSync } from "@/utils/label.server";
import { hasVariables } from "@/utils/template";
import prisma from "@/utils/prisma";
import { sendColdEmailNotification } from "@/utils/cold-email/send-notification";
import { extractEmailAddress } from "@/utils/email";
import { captureException } from "@/utils/error";
import { env } from "@/env";
import { ensureEmailSendingEnabled } from "@/utils/mail";
import { resolveDraftAttachments } from "@/utils/attachments/draft-attachments";
import { getReplyWithConfidence } from "@/utils/redis/reply";
import {
  type SelectedAttachment,
  attachmentSourceInputSchema,
} from "@/utils/attachments/source-schema";
import { AttachmentSourceType } from "@/generated/prisma/enums";
import {
  executeHomeAssistantAction,
  type HomeAssistantIntegrationType,
} from "@/utils/home-assistant";
import {
  sendA2aMessage,
  resolveA2aEndpoint,
  buildA2aEmailPayload,
  getRemoteAgentUrls,
} from "@/utils/a2a-client";
import { executeCreateTaskAction } from "@/utils/ai/actions/create-task";
import { isDeleteEmailActionEnabled } from "@/utils/delete-email-action";

const MODULE = "ai-actions";

type ActionFunction<T extends Partial<Omit<ActionItem, "type">>> = (options: {
  client: EmailProvider;
  email: EmailForAction;
  args: T;
  userEmail: string;
  userId: string;
  emailAccountId: string;
  executedRule: ExecutedRule;
  logger: Logger;
}) => Promise<any>;

export const runActionFunction = async (options: {
  client: EmailProvider;
  email: EmailForAction;
  action: ActionItem;
  userEmail: string;
  userId: string;
  emailAccountId: string;
  executedRule: ExecutedRule;
  logger: Logger;
}) => {
  const { action, userEmail, logger } = options;
  const log = logger.with({ module: MODULE });

  log.info("Running action", {
    actionType: action.type,
    userEmail,
    id: action.id,
  });
  log.trace("Running action", () => filterNullProperties(action));

  const { type, ...args } = action;
  const opts = {
    ...options,
    args,
    logger: log,
  };
  switch (type) {
    case ActionType.ARCHIVE:
      return archive(opts);
    case ActionType.LABEL:
      return label(opts);
    case ActionType.DRAFT_EMAIL:
      return draft(opts);
    case ActionType.REPLY:
      ensureEmailSendingEnabled();
      return reply(opts);
    case ActionType.SEND_EMAIL:
      ensureEmailSendingEnabled();
      return send_email(opts);
    case ActionType.FORWARD:
      ensureEmailSendingEnabled();
      return forward(opts);
    case ActionType.MARK_SPAM:
      return mark_spam(opts);
    case ActionType.CALL_WEBHOOK:
      return call_webhook(opts);
    case ActionType.MARK_READ:
      return mark_read(opts);
    case ActionType.DIGEST:
      return digest(opts);
    case ActionType.MOVE_FOLDER:
      return move_folder(opts);
    case ActionType.NOTIFY_SENDER:
      return notify_sender(opts);
    case ActionType.HOME_ASSISTANT:
      return home_assistant(opts);
    case ActionType.A2A_NOTIFY:
      return a2a_notify(opts);
    case ActionType.CREATE_TASK:
      return create_task(opts);
    case ActionType.DELETE:
      if (!isDeleteEmailActionEnabled()) {
        log.info(
          "Skipping delete action because delete email actions are disabled",
        );
        return;
      }
      return delete_email(opts);
    default:
      throw new Error(`Unknown action: ${action}`);
  }
};

const archive: ActionFunction<Record<string, unknown>> = async ({
  client,
  email,
  userEmail,
}) => {
  await client.archiveThread(email.threadId, userEmail);
};

const label: ActionFunction<{
  label?: string | null;
  labelId?: string | null;
}> = async ({ client, email, args, emailAccountId, logger }) => {
  logger.info("Label action started", {
    label: args.label,
    labelId: args.labelId,
  });

  const originalLabelId = args.labelId;
  let labelIdToUse = originalLabelId;

  if (!labelIdToUse && args.label) {
    if (hasVariables(args.label)) {
      logger.error("Template label not processed by AI", { label: args.label });
      return;
    }

    const matchingLabel = await client.getLabelByName(args.label);

    if (matchingLabel) {
      labelIdToUse = matchingLabel.id;
    } else {
      logger.info("Label not found, creating it", { labelName: args.label });
      const createdLabel = await client.createLabel(args.label);
      labelIdToUse = createdLabel.id;

      if (!labelIdToUse) {
        logger.error("Failed to create label", { labelName: args.label });
        return;
      }
    }
  }

  if (!labelIdToUse) return;

  await labelMessageAndSync({
    provider: client,
    messageId: email.id,
    labelId: labelIdToUse,
    labelName: args.label || null,
    emailAccountId,
    logger,
  });

  if (!originalLabelId && labelIdToUse && args.label) {
    after(() =>
      lazyUpdateActionLabelId({
        labelName: args.label!,
        labelId: labelIdToUse!,
        emailAccountId,
        logger,
      }),
    );
  }
};

const draft: ActionFunction<{
  subject?: string | null;
  content?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  staticAttachments?: ActionItem["staticAttachments"];
}> = async ({
  client,
  email,
  args,
  userEmail,
  userId,
  emailAccountId,
  executedRule,
  logger,
}) => {
  if (env.NEXT_PUBLIC_AUTO_DRAFT_DISABLED) return;

  const attachments = await resolveActionAttachments({
    email,
    emailAccountId,
    executedRule,
    userId,
    logger,
    staticAttachments: args.staticAttachments,
    includeAiSelectedAttachments: true,
  });

  const draftArgs = {
    to: args.to ?? undefined,
    subject: args.subject ?? undefined,
    content: args.content ?? "",
    cc: args.cc ?? undefined,
    bcc: args.bcc ?? undefined,
    attachments,
  };

  const result = await client.draftEmail(
    {
      id: email.id,
      threadId: email.threadId,
      headers: email.headers,
      internalDate: email.internalDate,
      snippet: "",
      historyId: "",
      inline: [],
      subject: email.headers.subject,
      date: email.headers.date,
      labelIds: [],
      textPlain: email.textPlain,
      textHtml: email.textHtml,
      attachments: email.attachments,
    },
    draftArgs,
    userEmail,
    executedRule,
  );
  return { draftId: result.draftId };
};

const reply: ActionFunction<{
  content?: string | null;
  cc?: string | null;
  bcc?: string | null;
  staticAttachments?: ActionItem["staticAttachments"];
}> = async ({
  client,
  email,
  args,
  userId,
  emailAccountId,
  executedRule,
  logger,
}) => {
  if (!args.content) return;

  const attachments = await resolveActionAttachments({
    email,
    emailAccountId,
    executedRule,
    userId,
    logger,
    staticAttachments: args.staticAttachments,
    includeAiSelectedAttachments: false,
  });

  await client.replyToEmail(
    {
      id: email.id,
      threadId: email.threadId,
      headers: email.headers,
      internalDate: email.internalDate,
      snippet: "",
      historyId: "",
      inline: [],
      subject: email.headers.subject,
      date: email.headers.date,
      textPlain: email.textPlain,
      textHtml: email.textHtml,
    },
    args.content,
    { attachments },
  );
};

const send_email: ActionFunction<{
  subject?: string | null;
  content?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
  staticAttachments?: ActionItem["staticAttachments"];
}> = async ({
  client,
  args,
  email,
  userId,
  emailAccountId,
  executedRule,
  logger,
}) => {
  if (!args.to || !args.subject || !args.content) return;

  const attachments = await resolveActionAttachments({
    email,
    emailAccountId,
    executedRule,
    userId,
    logger,
    staticAttachments: args.staticAttachments,
    includeAiSelectedAttachments: false,
  });

  const emailArgs = {
    to: args.to,
    cc: args.cc ?? undefined,
    bcc: args.bcc ?? undefined,
    subject: args.subject,
    messageText: args.content,
    attachments,
  };

  await client.sendEmail(emailArgs);
};

const forward: ActionFunction<{
  content?: string | null;
  to?: string | null;
  cc?: string | null;
  bcc?: string | null;
}> = async ({ client, email, args }) => {
  if (!args.to) return;

  const forwardArgs = {
    messageId: email.id,
    to: args.to,
    cc: args.cc ?? undefined,
    bcc: args.bcc ?? undefined,
    content: args.content ?? undefined,
  };

  await client.forwardEmail(
    {
      id: email.id,
      threadId: email.threadId,
      headers: email.headers,
      internalDate: email.internalDate,
      snippet: "",
      historyId: "",
      inline: [],
      subject: email.headers.subject,
      date: email.headers.date,
    },
    forwardArgs,
  );
};

const mark_spam: ActionFunction<Record<string, unknown>> = async ({
  client,
  email,
}) => {
  await client.markSpam(email.threadId);
};

const delete_email: ActionFunction<Record<string, unknown>> = async ({
  client,
  email,
  userEmail,
}) => {
  await client.trashThread(email.threadId, userEmail, "automation");
};

const call_webhook: ActionFunction<{ url?: string | null }> = async ({
  email,
  args,
  userId,
  executedRule,
}) => {
  if (!args.url) return;

  const payload = {
    email: {
      threadId: email.threadId,
      messageId: email.id,
      subject: email.headers.subject,
      from: email.headers.from,
      cc: email.headers.cc,
      bcc: email.headers.bcc,
      headerMessageId: email.headers["message-id"] || "",
    },
    executedRule: {
      id: executedRule.id,
      ruleId: executedRule.ruleId,
      reason: executedRule.reason,
      automated: executedRule.automated,
      createdAt: executedRule.createdAt,
    },
  };

  await callWebhook(userId, args.url, payload);
};

const mark_read: ActionFunction<Record<string, unknown>> = async ({
  client,
  email,
}) => {
  await client.markRead(email.threadId);
};

const digest: ActionFunction<{ id?: string }> = async ({
  email,
  emailAccountId,
  args,
  logger,
}) => {
  if (!args.id) return;
  const actionId = args.id;
  await enqueueDigestItem({ email, emailAccountId, actionId, logger });
};

const move_folder: ActionFunction<{
  folderId?: string | null;
  folderName?: string | null;
}> = async ({ client, email, userEmail, emailAccountId, args, logger }) => {
  const originalFolderId = args.folderId;
  let folderIdToUse = originalFolderId;

  // resolve folder name to ID if needed (similar to label resolution)
  if (!folderIdToUse && args.folderName) {
    if (hasVariables(args.folderName)) {
      logger.error("Template folder name not processed by AI", {
        folderName: args.folderName,
      });
      return;
    }

    logger.info("Resolving folder name to ID", { folderName: args.folderName });
    folderIdToUse = await client.getOrCreateFolderIdByName(args.folderName);

    if (!folderIdToUse) {
      logger.error("Failed to resolve folder", { folderName: args.folderName });
      return;
    }
  }

  if (!folderIdToUse) return;

  await client.moveThreadToFolder(email.threadId, userEmail, folderIdToUse);

  // lazy-update the folderId in the database for future runs
  if (!originalFolderId && folderIdToUse && args.folderName) {
    after(() =>
      lazyUpdateActionFolderId({
        folderName: args.folderName!,
        folderId: folderIdToUse!,
        emailAccountId,
        logger,
      }),
    );
  }
};

const notify_sender: ActionFunction<Record<string, unknown>> = async ({
  email,
  emailAccountId,
  userEmail,
  logger,
}) => {
  const senderEmail = extractEmailAddress(email.headers.from);
  if (!senderEmail) {
    logger.error("Could not extract sender email for notify_sender action");
    return { success: false, errorCode: "MISSING_SENDER_EMAIL" };
  }

  const result = await sendColdEmailNotification({
    senderEmail,
    recipientEmail: userEmail,
    originalSubject: email.headers.subject,
    originalMessageId: email.headers["message-id"],
    logger,
  });

  if (!result.success) {
    const errorCode =
      result.error === "Resend not configured"
        ? "RESEND_NOT_CONFIGURED"
        : "SEND_FAILED";

    // Best-effort: don't fail the whole rule run if notification can't be sent.
    logger.error("Cold email notification failed", {
      error: result.error,
      errorCode,
    });
    logger.trace("Cold email notification failed sender", { senderEmail });

    captureException(
      new Error(result.error ?? "Cold email notification failed"),
      {
        emailAccountId,
        extra: { actionType: ActionType.NOTIFY_SENDER },
        sampleRate: 0.01,
      },
    );
    return { success: false, errorCode };
  }

  return { success: true };
};

const home_assistant: ActionFunction<{
  haIntegrationType?: string | null;
  haWebhookId?: string | null;
  haMqttTopic?: string | null;
  haServiceDomain?: string | null;
  haServiceName?: string | null;
  haServiceData?: Prisma.JsonValue | null;
  haEntityId?: string | null;
}> = async ({ email, args, userId, executedRule, logger }) => {
  if (!args.haIntegrationType) {
    logger.error("Home Assistant integration type is required");
    return { success: false, errorCode: "MISSING_INTEGRATION_TYPE" };
  }

  const config = {
    type: args.haIntegrationType as HomeAssistantIntegrationType,
    webhookId: args.haWebhookId || undefined,
    mqttTopic: args.haMqttTopic || undefined,
    serviceDomain: args.haServiceDomain || undefined,
    serviceName: args.haServiceName || undefined,
    serviceData: toServiceData(args.haServiceData),
    entityId: args.haEntityId || undefined,
  };

  const emailData = {
    threadId: email.threadId,
    messageId: email.id,
    subject: email.headers.subject,
    from: email.headers.from,
    cc: email.headers.cc,
    bcc: email.headers.bcc,
    headerMessageId: email.headers["message-id"] || "",
    snippet: email.snippet,
    labels: email.labelIds,
    receivedAt: email.internalDate
      ? new Date(Number(email.internalDate))
      : undefined,
  };

  const ruleData = {
    id: executedRule.id,
    ruleId: executedRule.ruleId,
    ruleName: undefined, // TODO: fetch rule name if needed
  };

  try {
    await executeHomeAssistantAction(
      userId,
      emailData,
      ruleData,
      executedRule,
      config,
    );
    return { success: true };
  } catch (error) {
    logger.error("Home Assistant action failed", { error });
    captureException(
      error instanceof Error
        ? error
        : new Error("Home Assistant action failed"),
      {
        extra: { actionType: ActionType.HOME_ASSISTANT },
        sampleRate: 0.1,
      },
    );
    return { success: false, errorCode: "EXECUTION_FAILED" };
  }
};

const a2a_notify: ActionFunction<Record<string, unknown>> = async ({
  email,
  executedRule,
  logger,
}) => {
  const agentUrls = getRemoteAgentUrls();

  if (agentUrls.length === 0) {
    logger.error("No A2A agent URLs configured (A2A_REMOTE_AGENTS is empty)");
    return { success: false, errorCode: "NO_AGENT_URL" };
  }

  const payload = buildA2aEmailPayload(
    {
      from: email.headers.from,
      subject: email.headers.subject,
      snippet: email.snippet || "",
      threadId: email.threadId,
      messageId: email.id,
      receivedAt: email.internalDate
        ? new Date(Number(email.internalDate))
        : undefined,
    },
    { ruleId: executedRule.ruleId ?? "" },
  );

  const results = await Promise.allSettled(
    agentUrls.map(async (agentUrl) => {
      const endpoint = await resolveA2aEndpoint(agentUrl);
      return sendA2aMessage(endpoint, payload);
    }),
  );

  const anySuccess = results.some(
    (r) => r.status === "fulfilled" && !r.value.error,
  );

  if (!anySuccess) {
    logger.error("All A2A notifications failed", {
      agentCount: agentUrls.length,
    });
    return { success: false, errorCode: "ALL_AGENTS_FAILED" };
  }

  return { success: true };
};

const create_task: ActionFunction<Record<string, unknown>> = async ({
  email,
  emailAccountId,
}) => {
  await executeCreateTaskAction({ messageId: email.id, emailAccountId });
  return { success: true };
};

async function lazyUpdateActionLabelId({
  labelName,
  labelId,
  emailAccountId,
  logger,
}: {
  labelName: string;
  labelId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  try {
    const result = await prisma.action.updateMany({
      where: {
        label: labelName,
        labelId: null,
        rule: { emailAccountId },
      },
      data: { labelId },
    });

    if (result.count > 0) {
      logger.info("Lazy-updated Action labelId", {
        labelId,
        updatedCount: result.count,
      });
    }
  } catch (error) {
    logger.warn("Failed to lazy-update Action labelId", {
      labelId,
      error,
    });
  }
}

async function getDraftSelectedAttachments({
  email,
  emailAccountId,
  executedRule,
  logger,
}: {
  email: EmailForAction;
  emailAccountId: string;
  executedRule: ExecutedRule;
  logger: Logger;
}): Promise<SelectedAttachment[]> {
  if (!executedRule.ruleId) return [];

  const cachedDraft = await getReplyWithConfidence({
    emailAccountId,
    messageId: email.id,
    ruleId: executedRule.ruleId,
  });

  if (cachedDraft) {
    return cachedDraft.attachments ?? [];
  }

  // Do not re-run attachment selection on a cache miss. The draft content was
  // generated based on a specific set of files; re-selecting could attach a
  // different PDF than the draft references, causing a content/attachment mismatch.
  logger.warn("Draft attachment cache missing, skipping attachments", {
    messageId: email.id,
    ruleId: executedRule.ruleId,
  });
  return [];
}

async function resolveActionAttachments({
  email,
  emailAccountId,
  executedRule,
  userId,
  logger,
  staticAttachments,
  includeAiSelectedAttachments,
}: {
  email: EmailForAction;
  emailAccountId: string;
  executedRule: ExecutedRule;
  userId: string;
  logger: Logger;
  staticAttachments?: ActionItem["staticAttachments"];
  includeAiSelectedAttachments: boolean;
}) {
  const [aiSelectedAttachments, staticSelected] = await Promise.all([
    includeAiSelectedAttachments
      ? getDraftSelectedAttachments({
          email,
          emailAccountId,
          executedRule,
          logger,
        })
      : Promise.resolve([]),
    Promise.resolve(parseStaticAttachments(staticAttachments)),
  ]);

  const allSelected = [
    ...new Map(
      [...aiSelectedAttachments, ...staticSelected].map((attachment) => [
        `${attachment.driveConnectionId}:${attachment.fileId}`,
        attachment,
      ]),
    ).values(),
  ];

  if (allSelected.length === 0) return [];

  const attachments = await resolveDraftAttachments({
    emailAccountId,
    userId,
    selectedAttachments: allSelected,
    logger,
  });

  if (attachments.length === 0) {
    logger.warn("Selected rule attachments could not be resolved", {
      messageId: email.id,
      ruleId: executedRule.ruleId,
      selectedAttachmentCount: allSelected.length,
    });
  }

  return attachments;
}

async function lazyUpdateActionFolderId({
  folderName,
  folderId,
  emailAccountId,
  logger,
}: {
  folderName: string;
  folderId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  try {
    const result = await prisma.action.updateMany({
      where: {
        folderName,
        folderId: null,
        rule: { emailAccountId },
      },
      data: { folderId },
    });

    if (result.count > 0) {
      logger.info("Lazy-updated Action folderId", {
        folderId,
        updatedCount: result.count,
      });
    }
  } catch (error) {
    logger.warn("Failed to lazy-update Action folderId", {
      folderId,
      error,
    });
  }
}

function parseStaticAttachments(raw: unknown): SelectedAttachment[] {
  if (!raw || !Array.isArray(raw) || raw.length === 0) return [];

  const parsed = attachmentSourceInputSchema.array().safeParse(raw);

  if (!parsed.success) return [];

  return parsed.data
    .filter((item) => item.type === AttachmentSourceType.FILE)
    .map((item) => ({
      driveConnectionId: item.driveConnectionId,
      fileId: item.sourceId,
      filename: item.name,
      mimeType: "application/pdf",
    }));
}

/**
 * haServiceData is a Json column, so it may hold a scalar or array. Home
 * Assistant spreads it into a service-call payload, which only makes sense for
 * an object; anything else is dropped rather than spread into garbage.
 */
function toServiceData(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return undefined;
}
