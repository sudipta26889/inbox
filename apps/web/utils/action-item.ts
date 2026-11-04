import { ActionType } from "@/generated/prisma/enums";
import type { Action, ExecutedAction } from "@/generated/prisma/client";

export const actionInputs: Record<
  ActionType,
  {
    fields: {
      name:
        | "labelId"
        | "subject"
        | "content"
        | "to"
        | "cc"
        | "bcc"
        | "url"
        | "folderName"
        | "folderId";
      label: string;
      textArea?: boolean;
      expandable?: boolean;
      placeholder?: string;
    }[];
  }
> = {
  [ActionType.ARCHIVE]: { fields: [] },
  [ActionType.LABEL]: {
    fields: [
      {
        name: "labelId",
        label: "Label",
      },
    ],
  },
  [ActionType.DIGEST]: { fields: [] },
  [ActionType.DRAFT_EMAIL]: {
    fields: [
      {
        name: "subject",
        label: "Subject",
        expandable: true,
      },
      {
        name: "content",
        label: "Content",
        textArea: true,
      },
      {
        name: "to",
        label: "To",
        expandable: true,
      },
      {
        name: "cc",
        label: "CC",
        expandable: true,
      },
      {
        name: "bcc",
        label: "BCC",
        expandable: true,
      },
    ],
  },
  [ActionType.REPLY]: {
    fields: [
      {
        name: "content",
        label: "Content",
        textArea: true,
      },
      {
        name: "cc",
        label: "CC",
        expandable: true,
      },
      {
        name: "bcc",
        label: "BCC",
        expandable: true,
      },
    ],
  },
  [ActionType.SEND_EMAIL]: {
    fields: [
      {
        name: "subject",
        label: "Subject",
      },
      {
        name: "content",
        label: "Content",
        textArea: true,
      },
      {
        name: "to",
        label: "To",
      },
      {
        name: "cc",
        label: "CC",
        expandable: true,
      },
      {
        name: "bcc",
        label: "BCC",
        expandable: true,
      },
    ],
  },
  [ActionType.FORWARD]: {
    fields: [
      {
        name: "to",
        label: "To",
      },
      {
        name: "content",
        label: "Extra Content",
        textArea: true,
      },
      {
        name: "cc",
        label: "CC",
        expandable: true,
      },
      {
        name: "bcc",
        label: "BCC",
        expandable: true,
      },
    ],
  },
  [ActionType.MARK_SPAM]: { fields: [] },
  [ActionType.CALL_WEBHOOK]: {
    fields: [
      {
        name: "url",
        label: "Webhook URL",
        placeholder: "https://example.com/webhook",
      },
    ],
  },
  [ActionType.MARK_READ]: { fields: [] },
  [ActionType.MOVE_FOLDER]: {
    fields: [
      {
        name: "folderName",
        label: "Folder name",
      },
    ],
  },
  [ActionType.NOTIFY_SENDER]: {
    fields: [],
  },
  [ActionType.HOME_ASSISTANT]: {
    fields: [], // Custom component will handle rendering
  },
  [ActionType.A2A_NOTIFY]: {
    fields: [],
  },
  [ActionType.DELETE]: {
    fields: [],
  },
  [ActionType.CREATE_TASK]: {
    fields: [],
  },
};

export function getActionFields(fields: Action | ExecutedAction | undefined) {
  const res: {
    label?: string;
    subject?: string;
    content?: string;
    to?: string;
    cc?: string;
    bcc?: string;
    url?: string;
    folderName?: string;
    folderId?: string;
  } = {};

  // only return fields with a value
  if (fields?.label) res.label = fields.label;
  if (fields?.subject) res.subject = fields.subject;
  if (fields?.content) res.content = fields.content;
  if (fields?.to) res.to = fields.to;
  if (fields?.cc) res.cc = fields.cc;
  if (fields?.bcc) res.bcc = fields.bcc;
  if (fields?.url) res.url = fields.url;
  if (fields?.folderName) res.folderName = fields.folderName;
  if (fields?.folderId) res.folderId = fields.folderId;

  return res;
}
