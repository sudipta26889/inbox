import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import { getTaskpilotConfigStatus } from "@/utils/taskpilot/config";

export type TaskpilotStatusResponse = {
  configured: boolean;
  workspaceSlug: string | null;
};

export const GET = withAuth("user/me/taskpilot-status", async (request) => {
  const { userId } = request.auth;
  const status = await getTaskpilotConfigStatus(userId);
  return NextResponse.json<TaskpilotStatusResponse>(status);
});
