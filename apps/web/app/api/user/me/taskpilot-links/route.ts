import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { buildTaskpilotUrl } from "@/utils/taskpilot/service";
import { taskpilotLinksBody } from "@/app/api/user/me/taskpilot-links/validation";

export type TaskpilotLinksResponse = Record<
  string,
  { identifier: string; url: string } | undefined
>;

// Keyed by thread: a reply after the conversion must keep the badge. Links
// match by threadId, or by message id for links saved without one.
export const POST = withEmailAccount(
  "user/me/taskpilot-links",
  async (request) => {
    const { emailAccountId } = request.auth;
    const parsed = taskpilotLinksBody.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid request", isKnownError: true },
        { status: 400 },
      );
    }

    const threadByMessageId = new Map<string, string>();
    for (const thread of parsed.data.threads) {
      for (const messageId of thread.messageIds) {
        threadByMessageId.set(messageId, thread.threadId);
      }
    }
    const threadIds = new Set(parsed.data.threads.map((t) => t.threadId));

    const rows = await prisma.emailTaskLink.findMany({
      where: {
        emailAccountId,
        OR: [
          { threadId: { in: [...threadIds] } },
          { gmailMessageId: { in: [...threadByMessageId.keys()] } },
        ],
      },
      select: {
        gmailMessageId: true,
        threadId: true,
        taskpilotIdentifier: true,
        workspaceSlug: true,
      },
      orderBy: { createdAt: "asc" },
    });

    const result: TaskpilotLinksResponse = {};
    for (const row of rows) {
      const threadId =
        row.threadId && threadIds.has(row.threadId)
          ? row.threadId
          : threadByMessageId.get(row.gmailMessageId);
      if (!threadId) continue;
      // ponytail: one badge per thread, the newest link wins.
      result[threadId] = {
        identifier: row.taskpilotIdentifier,
        url: buildTaskpilotUrl(row.workspaceSlug, row.taskpilotIdentifier),
      };
    }
    return NextResponse.json(result);
  },
);
