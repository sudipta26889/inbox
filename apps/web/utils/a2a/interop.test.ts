import { describe, expect, it } from "vitest";
import { normalizeA2aMethod, normalizeMessageSendParams } from "./interop";

describe("normalizeA2aMethod", () => {
  it("accepts this server's original dot form", () => {
    expect(normalizeA2aMethod("message.send")).toBe("message.send");
    expect(normalizeA2aMethod("task.cancel")).toBe("task.cancel");
  });

  // This codebase's own outbound client sends the slash form, so before this
  // existed Inbox could not talk to Inbox.
  it("accepts the A2A spec slash form", () => {
    expect(normalizeA2aMethod("message/send")).toBe("message.send");
    expect(normalizeA2aMethod("tasks/get")).toBe("task.get");
    expect(normalizeA2aMethod("tasks/cancel")).toBe("task.cancel");
  });

  // OpenClaw's built-in a2a channel transcodes from proto.
  it("accepts the proto form, case-insensitively", () => {
    expect(normalizeA2aMethod("SendMessage")).toBe("message.send");
    expect(normalizeA2aMethod("GetTask")).toBe("task.get");
    expect(normalizeA2aMethod("sendmessage")).toBe("message.send");
  });

  it("returns null for anything unrecognised", () => {
    expect(normalizeA2aMethod("message/stream")).toBeNull();
    expect(normalizeA2aMethod("")).toBeNull();
  });
});

describe("normalizeMessageSendParams", () => {
  it("passes the flat form through untouched", () => {
    const flat = { contextId: "ctx-1", skill: "email.search", content: "hi" };

    expect(normalizeMessageSendParams(flat)).toMatchObject(flat);
  });

  // OpenClaw omits `kind` and sends bare { text } parts.
  it("reads OpenClaw's message envelope", () => {
    const result = normalizeMessageSendParams({
      message: {
        messageId: "m-1",
        role: "ROLE_USER",
        contextId: "ctx-oc-inboxagent",
        parts: [{ text: "first" }, { text: "second" }],
      },
      configuration: { returnImmediately: true },
    });

    expect(result.contextId).toBe("ctx-oc-inboxagent");
    expect(result.content).toBe("first\nsecond");
  });

  it("reads the spec envelope this codebase itself emits", () => {
    const result = normalizeMessageSendParams({
      message: {
        kind: "message",
        messageId: "m-2",
        role: "user",
        contextId: "inbox-digest-2026-09-06",
        parts: [
          { kind: "text", text: "Daily digest" },
          { kind: "data", data: { kind: "inbox.daily_digest" } },
        ],
      },
      configuration: { blocking: true },
    });

    expect(result.contextId).toBe("inbox-digest-2026-09-06");
    expect(result.content).toBe("Daily digest");
    expect(result.input).toEqual({ kind: "inbox.daily_digest" });
  });

  // contextId is optional on the wire but required by the storage model;
  // rejecting the message outright would be the wrong trade.
  it("derives a contextId when the sender omits one", () => {
    const result = normalizeMessageSendParams({
      message: { messageId: "m-3", parts: [{ text: "no context" }] },
    });

    expect(result.contextId).toBe("a2a-m-3");
  });
});
