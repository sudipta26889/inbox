import type { Prisma } from "@/generated/prisma/client";
import { ActionType } from "@/generated/prisma/enums";
import { sanitizeActionFields } from "@/utils/action-item";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { SafeError } from "@/utils/error";
import { validateGmailLabelName } from "@/utils/gmail/label-validation";
import { resolveLabelNameAndId } from "@/utils/label/resolve-label";
import type { Logger } from "@/utils/logger";
import type { AttachmentSourceInput } from "@/utils/attachments/source-schema";

export function mapActionToSanitizedFields(action: {
  type: ActionType;
  labelId?: {
    name?: string | null;
    value?: string | null;
    ai?: boolean | null;
  } | null;
  subject?: { value?: string | null } | null;
  content?: { value?: string | null } | null;
  to?: { value?: string | null } | null;
  cc?: { value?: string | null } | null;
  bcc?: { value?: string | null } | null;
  url?: { value?: string | null } | null;
  folderName?: { value?: string | null } | null;
  folderId?: { value?: string | null } | null;
  delayInMinutes?: number | null;
  staticAttachments?: AttachmentSourceInput[] | null;
  // Home Assistant fields
  haIntegrationType?: string | null;
  haWebhookId?: string | null;
  haMqttTopic?: string | null;
  haServiceDomain?: string | null;
  haServiceName?: string | null;
  haServiceData?: Prisma.JsonValue | null;
  haEntityId?: string | null;
}) {
  const sanitized = sanitizeActionFields({
    type: action.type,
    label: action.labelId?.name,
    labelId: action.labelId?.value,
    subject: action.subject?.value,
    content: action.content?.value,
    to: action.to?.value,
    cc: action.cc?.value,
    bcc: action.bcc?.value,
    url: action.url?.value,
    folderName: action.folderName?.value,
    folderId: action.folderId?.value,
    delayInMinutes: action.delayInMinutes,
    staticAttachments: action.staticAttachments?.length
      ? action.staticAttachments
      : undefined,
    // Home Assistant fields
    haIntegrationType: action.haIntegrationType,
    haWebhookId: action.haWebhookId,
    haMqttTopic: action.haMqttTopic,
    haServiceDomain: action.haServiceDomain,
    haServiceName: action.haServiceName,
    haServiceData: action.haServiceData,
    haEntityId: action.haEntityId,
  });

  return {
    type: sanitized.type,
    fields: {
      label: sanitized.label ?? null,
      to: sanitized.to ?? null,
      cc: sanitized.cc ?? null,
      bcc: sanitized.bcc ?? null,
      subject: sanitized.subject ?? null,
      content: sanitized.content ?? null,
      webhookUrl: sanitized.url ?? null,
      folderName: sanitized.folderName ?? null,
    },
    labelId: sanitized.labelId ?? null,
    folderId: sanitized.folderId ?? null,
    delayInMinutes: sanitized.delayInMinutes ?? null,
    staticAttachments: sanitized.staticAttachments ?? null,
    // Home Assistant fields
    haIntegrationType: sanitized.haIntegrationType ?? null,
    haWebhookId: sanitized.haWebhookId ?? null,
    haMqttTopic: sanitized.haMqttTopic ?? null,
    haServiceDomain: sanitized.haServiceDomain ?? null,
    haServiceName: sanitized.haServiceName ?? null,
    haServiceData: sanitized.haServiceData ?? null,
    haEntityId: sanitized.haEntityId ?? null,
  };
}

export async function resolveActionLabels<
  T extends {
    type: ActionType;
    labelId?: {
      name?: string | null;
      value?: string | null;
      ai?: boolean | null;
    } | null;
    folderName?: {
      value?: string | null;
    } | null;
    folderId?: {
      value?: string | null;
    } | null;
  },
>(actions: T[], emailAccountId: string, provider: string, logger: Logger) {
  const emailProvider = await createEmailProvider({
    emailAccountId,
    provider,
    logger,
  });

  return Promise.all(
    actions.map(async (action) => {
      if (action.type === ActionType.LABEL) {
        const labelName = action.labelId?.name || action.labelId?.value || null;

        if (isGoogleProvider(provider) && labelName) {
          const validation = validateGmailLabelName(labelName);
          if (!validation.valid) {
            throw new SafeError(validation.error);
          }
        }

        const { label: resolvedLabel, labelId: resolvedLabelId } =
          await resolveLabelNameAndId({
            emailProvider,
            label: action.labelId?.name || null,
            labelId: action.labelId?.value || null,
          });
        return {
          ...action,
          labelId: {
            value: resolvedLabelId,
            name: resolvedLabel,
            ai: action.labelId?.ai,
          },
        };
      }
      if (action.type === ActionType.MOVE_FOLDER) {
        const folderName = action.folderName?.value;
        if (folderName && !action.folderId?.value) {
          const resolvedFolderId =
            await emailProvider.getOrCreateFolderIdByName(folderName);
          return {
            ...action,
            folderId: {
              value: resolvedFolderId,
            },
            folderName: {
              value: folderName,
            },
          };
        }
      }
      return action;
    }),
  );
}
