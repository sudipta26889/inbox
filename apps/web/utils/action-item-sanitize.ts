import { ActionType } from "@/generated/prisma/enums";
import { Prisma } from "@/generated/prisma/client";

// Server only: Prisma's client entry imports node:module, so action-item.ts (which reaches the browser) cannot hold this.
type ActionFieldsSelection = Pick<
  Prisma.ActionCreateInput,
  | "type"
  | "label"
  | "labelId"
  | "subject"
  | "content"
  | "to"
  | "cc"
  | "bcc"
  | "url"
  | "folderName"
  | "folderId"
  | "delayInMinutes"
  | "staticAttachments"
  | "haIntegrationType"
  | "haWebhookId"
  | "haMqttTopic"
  | "haServiceDomain"
  | "haServiceName"
  | "haServiceData"
  | "haEntityId"
>;

// Callers pass rows read from the DB, where Json columns are JsonValue (null
// included). The create-input type excludes null, so both Json fields are
// overridden the same way.
type SanitizableActionFields = Partial<
  Omit<ActionFieldsSelection, "staticAttachments" | "haServiceData">
> & {
  type: ActionType;
  staticAttachments?: Prisma.JsonValue | null;
  haServiceData?: Prisma.JsonValue | null;
};

export function sanitizeActionFields(
  action: SanitizableActionFields,
): ActionFieldsSelection {
  const supportsStaticAttachments =
    action.type === ActionType.DRAFT_EMAIL ||
    action.type === ActionType.REPLY ||
    action.type === ActionType.SEND_EMAIL;

  const base: ActionFieldsSelection = {
    type: action.type,
    label: null,
    labelId: null,
    subject: null,
    content: null,
    to: null,
    cc: null,
    bcc: null,
    url: null,
    folderName: null,
    folderId: null,
    delayInMinutes: action.delayInMinutes || null,
    staticAttachments: supportsStaticAttachments
      ? (action.staticAttachments ?? undefined)
      : undefined,
    haIntegrationType: null,
    haWebhookId: null,
    haMqttTopic: null,
    haServiceDomain: null,
    haServiceName: null,
    haServiceData: Prisma.DbNull,
    haEntityId: null,
  };

  switch (action.type) {
    case ActionType.ARCHIVE:
    case ActionType.MARK_SPAM:
    case ActionType.MARK_READ:
    case ActionType.DIGEST:
    case ActionType.DELETE:
      return base;
    case ActionType.MOVE_FOLDER: {
      return {
        ...base,
        folderName: action.folderName ?? null,
        folderId: action.folderId ?? null,
      };
    }
    case ActionType.LABEL: {
      return {
        ...base,
        label: action.label ?? null,
        labelId: action.labelId ?? null,
      };
    }
    case ActionType.REPLY: {
      return {
        ...base,
        content: action.content ?? null,
        cc: action.cc ?? null,
        bcc: action.bcc ?? null,
      };
    }
    case ActionType.SEND_EMAIL: {
      return {
        ...base,
        subject: action.subject ?? null,
        content: action.content ?? null,
        to: action.to ?? null,
        cc: action.cc ?? null,
        bcc: action.bcc ?? null,
      };
    }
    case ActionType.FORWARD: {
      return {
        ...base,
        content: action.content ?? null,
        to: action.to ?? null,
        cc: action.cc ?? null,
        bcc: action.bcc ?? null,
      };
    }
    case ActionType.DRAFT_EMAIL: {
      return {
        ...base,
        subject: action.subject ?? null,
        content: action.content ?? null,
        to: action.to ?? null,
        cc: action.cc ?? null,
        bcc: action.bcc ?? null,
      };
    }
    case ActionType.CALL_WEBHOOK: {
      return {
        ...base,
        url: action.url ?? null,
      };
    }
    case ActionType.NOTIFY_SENDER: {
      return base;
    }
    case ActionType.HOME_ASSISTANT: {
      return {
        ...base,
        haIntegrationType: action.haIntegrationType ?? null,
        haWebhookId: action.haWebhookId ?? null,
        haMqttTopic: action.haMqttTopic ?? null,
        haServiceDomain: action.haServiceDomain ?? null,
        haServiceName: action.haServiceName ?? null,
        haServiceData: action.haServiceData ?? Prisma.DbNull,
        haEntityId: action.haEntityId ?? null,
      };
    }
    case ActionType.A2A_NOTIFY:
      return base;
    case ActionType.CREATE_TASK:
      return base;
    default:
      // biome-ignore lint/correctness/noSwitchDeclarations: intentional exhaustive check
      const exhaustiveCheck: never = action.type;
      return exhaustiveCheck;
  }
}
