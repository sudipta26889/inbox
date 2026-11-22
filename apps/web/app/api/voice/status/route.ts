import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { getVoiceStatus } from "@/utils/voice/runtime";

export type GetVoiceStatusResponse = ReturnType<typeof getVoiceStatus>;

export const GET = withEmailAccount("voice/status", async () =>
  NextResponse.json(getVoiceStatus()),
);
