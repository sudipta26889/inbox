import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SystemType } from "@/generated/prisma/enums";
import { sendA2aMessage } from "@/utils/a2a-client";
import { createScopedLogger } from "@/utils/logger";
import type { ParsedMessage } from "@/utils/types";
import { fanOutEmailAnalysis } from "./email-fanout";

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}));
vi.mock("@/env", () => ({ env: mockEnv }));
vi.mock("@/utils/a2a-client", () => ({
  getRemoteAgentUrls: () => ["http://mitra.test"],
  resolveA2aEndpoint: async () => "http://mitra.test/a2a",
  sendA2aMessage: vi.fn(async () => ({ taskId: "t1" })),
}));

const logger = createScopedLogger("email-fanout-test");
const message = {
  id: "msg-1",
  threadId: "thread-1",
  internalDate: "1791800000000",
  snippet: "Please send the signed contract",
  textPlain: "Please send the signed contract by Friday.",
  headers: {
    from: "raj@client.example",
    to: "owner@company.example",
    subject: "Contract",
  },
} as unknown as ParsedMessage;

describe("fanOutEmailAnalysis", () => {
  const fetchMock = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response("{}", { status: 202 }),
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnv.A2A_FANOUT_ALL_EMAILS = "true";
    mockEnv.MEETECHO_INBOX_INGEST_URL = "http://meetecho.test/ingest/inbox";
    mockEnv.MEETECHO_A2A_TOKEN = "me-token";
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("sends a relevant email's analysis to Mitra and MeetEcho", async () => {
    fanOutEmailAnalysis({
      message,
      accountEmail: "owner@company.example",
      rules: [
        {
          name: "To Reply",
          systemType: SystemType.TO_REPLY,
          reason: "Asks for a contract",
        },
      ],
      mitraAlreadyNotified: false,
      logger,
    });
    await flush();

    expect(sendA2aMessage).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1].body));
    expect(body).toMatchObject({
      message_id: "msg-1",
      thread_id: "thread-1",
      intent: "reference",
      labels: ["To Reply"],
    });
    expect(body.snippet).toContain("To Reply: Asks for a contract");
  });

  it("sends nothing for noise such as newsletters", async () => {
    fanOutEmailAnalysis({
      message,
      accountEmail: "owner@company.example",
      rules: [{ name: "Newsletter", systemType: SystemType.NEWSLETTER }],
      mitraAlreadyNotified: false,
      logger,
    });
    await flush();

    expect(sendA2aMessage).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't message Mitra twice when a rule's A2A_NOTIFY already did", async () => {
    fanOutEmailAnalysis({
      message,
      accountEmail: "owner@company.example",
      rules: [{ name: "Urgent", systemType: null }],
      mitraAlreadyNotified: true,
      logger,
    });
    await flush();

    expect(sendA2aMessage).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves MeetEcho off until its token is set", async () => {
    mockEnv.MEETECHO_A2A_TOKEN = "";
    fanOutEmailAnalysis({
      message,
      accountEmail: "owner@company.example",
      rules: [],
      skippedReason: "No rules matched",
      mitraAlreadyNotified: false,
      logger,
    });
    await flush();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(sendA2aMessage).toHaveBeenCalledTimes(1);
  });
});

function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
