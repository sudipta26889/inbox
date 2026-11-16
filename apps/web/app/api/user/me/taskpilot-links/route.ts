import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type TaskpilotLinksResponse = Record<
  string,
  { identifier: string; url: string } | undefined
>;

export const GET = withEmailAccount(
  "user/me/taskpilot-links",
  async (request) => {
    const { emailAccountId } = request.auth;
    const ids = new URL(request.url).searchParams.get("messageIds") ?? "";
    const messageIds = ids
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 200);
    if (!messageIds.length) {
      return NextResponse.json<TaskpilotLinksResponse>({});
    }

    const rows = await prisma.emailTaskLink.findMany({
      where: { emailAccountId, gmailMessageId: { in: messageIds } },
      select: {
        gmailMessageId: true,
        taskpilotIdentifier: true,
        workspaceSlug: true,
      },
    });
    const result: TaskpilotLinksResponse = {};
    for (const row of rows) {
      result[row.gmailMessageId] = {
        identifier: row.taskpilotIdentifier,
        url: `https://taskpilot.sudiptadhara.in/${row.workspaceSlug}/browse/${row.taskpilotIdentifier}`,
      };
    }
    return NextResponse.json(result);
  },
);
