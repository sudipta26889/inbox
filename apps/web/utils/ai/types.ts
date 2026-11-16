import type { ParsedMessage } from "@/utils/types";
import type {
  EmailAccount,
  ExecutedAction,
  ExecutedRule,
} from "@/generated/prisma/client";

export type EmailForAction = Pick<
  ParsedMessage,
  | "externalUrl"
  | "threadId"
  | "id"
  | "headers"
  | "textPlain"
  | "textHtml"
  | "snippet"
  | "attachments"
  | "internalDate"
  | "rawRecipients"
  // Home Assistant payloads forward labels; without this the field was always
  // undefined at the call site.
  | "labelIds"
>;

export type ActionItem = {
  id: ExecutedAction["id"];
  type: ExecutedAction["type"];
  messagingChannelId?: ExecutedAction["messagingChannelId"];
  label?: ExecutedAction["label"];
  labelId?: ExecutedAction["labelId"];
  subject?: ExecutedAction["subject"];
  content?: ExecutedAction["content"];
  to?: ExecutedAction["to"];
  cc?: ExecutedAction["cc"];
  bcc?: ExecutedAction["bcc"];
  url?: ExecutedAction["url"];
  folderName?: ExecutedAction["folderName"];
  folderId?: ExecutedAction["folderId"];
  delayInMinutes?: number | null;
  staticAttachments?: ExecutedAction["staticAttachments"];
  selectedAttachments?: ExecutedAction["selectedAttachments"];
  integrationName?: ExecutedAction["integrationName"];
  integrationToolName?: ExecutedAction["integrationToolName"];
  integrationArgs?: ExecutedAction["integrationArgs"];
  haIntegrationType?: ExecutedAction["haIntegrationType"];
  haWebhookId?: ExecutedAction["haWebhookId"];
  haMqttTopic?: ExecutedAction["haMqttTopic"];
  haServiceDomain?: ExecutedAction["haServiceDomain"];
  haServiceName?: ExecutedAction["haServiceName"];
  haServiceData?: ExecutedAction["haServiceData"];
  haEntityId?: ExecutedAction["haEntityId"];
};

export type ActionExecutionEmailAccount = Pick<
  EmailAccount,
  "email" | "id" | "userId"
>;

export type ExecutedRuleForAction = ExecutedRule & {
  actionItems?: Pick<ActionItem, "type">[];
};
