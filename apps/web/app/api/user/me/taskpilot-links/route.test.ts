import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (_name: string, handler: (request: Request) => Promise<Response>) =>
    (request: Request) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "acc-1", userId: "user-1" },
        }),
      ),
}));

import { POST } from "./route";

describe("POST /api/user/me/taskpilot-links", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailTaskLink.findMany.mockResolvedValue([]);
  });

  it("keys a link by its thread, so a later reply keeps the badge", async () => {
    prisma.emailTaskLink.findMany.mockResolvedValue([
      link({ gmailMessageId: "m1", threadId: "t1", identifier: "WEB-1" }),
    ] as never);

    const body = await post([{ threadId: "t1", messageIds: ["m1", "m2"] }]);

    expect(body).toEqual({
      t1: {
        identifier: "WEB-1",
        url: "https://taskpilot.sudiptadhara.in/ws/browse/WEB-1",
      },
    });
    expect(prisma.emailTaskLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ emailAccountId: "acc-1" }),
      }),
    );
  });

  it("maps a link saved without a thread id through its message", async () => {
    prisma.emailTaskLink.findMany.mockResolvedValue([
      link({ gmailMessageId: "m2", threadId: null, identifier: "OPS-3" }),
    ] as never);

    const body = await post([{ threadId: "t9", messageIds: ["m1", "m2"] }]);

    expect(Object.keys(body)).toEqual(["t9"]);
  });

  it("refuses more threads than one chunk instead of truncating", async () => {
    const threads = Array.from({ length: 101 }, (_, i) => ({
      threadId: `t${i}`,
      messageIds: [`m${i}`],
    }));

    const response = await POST(request(threads));

    expect(response.status).toBe(400);
    expect(prisma.emailTaskLink.findMany).not.toHaveBeenCalled();
  });
});

async function post(threads: { threadId: string; messageIds: string[] }[]) {
  const response = await POST(request(threads));
  expect(response.status).toBe(200);
  return response.json();
}

function request(threads: unknown) {
  return new Request("http://localhost/api/user/me/taskpilot-links", {
    method: "POST",
    body: JSON.stringify({ threads }),
  }) as never;
}

function link({
  gmailMessageId,
  threadId,
  identifier,
}: {
  gmailMessageId: string;
  threadId: string | null;
  identifier: string;
}) {
  return {
    gmailMessageId,
    threadId,
    taskpilotIdentifier: identifier,
    workspaceSlug: "ws",
  };
}
