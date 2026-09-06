import type { MessageSendParams } from "@/utils/a2a/protocol-handler";

/**
 * A2A wire-format compatibility.
 *
 * Three spellings of the same call are in the wild, and this server previously
 * accepted only its own:
 *
 *   message.send   this server's original dot form
 *   message/send   the A2A spec form (what THIS codebase's own client sends)
 *   SendMessage    the proto/gRPC-transcoded form (OpenClaw's built-in channel)
 *
 * The params disagree too: the spec nests everything under `params.message`,
 * while the handlers here expect a flat `{ contextId, skill, content }`. The
 * net effect was that Inbox could not talk to Inbox — the outbound client
 * sends `message/send` with `params.message.parts`, which the inbound
 * dispatcher answered with "Method not found".
 */

const METHOD_ALIASES: Record<string, string> = {
  "message.send": "message.send",
  "message/send": "message.send",
  sendmessage: "message.send",

  "task.get": "task.get",
  "tasks/get": "task.get",
  gettask: "task.get",

  "task.list": "task.list",
  "tasks/list": "task.list",
  listtasks: "task.list",

  "task.cancel": "task.cancel",
  "tasks/cancel": "task.cancel",
  canceltask: "task.cancel",

  "context.get": "context.get",
  "contexts/get": "context.get",
  getcontext: "context.get",
};

/** Map any accepted spelling onto this server's canonical method name. */
export function normalizeA2aMethod(method: string): string | null {
  return METHOD_ALIASES[method] ?? METHOD_ALIASES[method.toLowerCase()] ?? null;
}

type SpecPart = {
  kind?: string;
  text?: string;
  data?: Record<string, unknown>;
};

type SpecMessage = {
  messageId?: string;
  role?: string;
  contextId?: string;
  parts?: SpecPart[];
  metadata?: Record<string, unknown>;
  referenceTaskIds?: string[];
};

/**
 * Accept either the flat params this server defined or the spec's
 * `{ message: { parts: [...] } }` envelope, and return the flat form.
 *
 * Parts may or may not carry `kind` — OpenClaw omits it and sends bare
 * `{ text }` — so text and data parts are detected by which field is present.
 */
export function normalizeMessageSendParams(
  raw: Record<string, unknown>,
): MessageSendParams {
  const message = raw.message as SpecMessage | undefined;

  if (!message) return raw as unknown as MessageSendParams;

  const parts = message.parts ?? [];
  const text = parts
    .filter((part) => typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  const dataPart = parts.find(
    (part) => part.data && typeof part.data === "object",
  );

  // contextId is required by this server's storage model but optional on the
  // wire; derive a stable-enough one rather than rejecting the message.
  const contextId =
    message.contextId ??
    (raw.contextId as string | undefined) ??
    `a2a-${message.messageId ?? Date.now()}`;

  const skill =
    (raw.skill as string | undefined) ??
    (message.metadata?.skill as string | undefined);

  return {
    contextId,
    skill,
    input:
      (raw.input as Record<string, unknown> | undefined) ??
      (dataPart?.data as Record<string, unknown> | undefined),
    content: text || dataPart?.data ? (text ?? "") : undefined,
    referenceTaskIds:
      message.referenceTaskIds ??
      (raw.referenceTaskIds as string[] | undefined),
  };
}
