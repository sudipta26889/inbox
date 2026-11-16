import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

const homeAssistantSchema = z.object({
  homeAssistantUrl: z.string().url().min(1),
  // Optional on update: the saved token is never sent to the browser, so a
  // blank field means "keep the one already saved".
  homeAssistantToken: z.string().min(1).optional(),
});

export const POST = withAuth(
  "user/settings/home-assistant",
  async (request) => {
    const parsed = homeAssistantSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "Invalid input", details: parsed.error.issues },
        { status: 400 },
      );
    }

    const { homeAssistantUrl, homeAssistantToken } = parsed.data;
    const userId = request.auth.userId;

    if (!homeAssistantToken) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { homeAssistantToken: true },
      });
      if (!user?.homeAssistantToken) {
        return NextResponse.json(
          { error: "Access token is required" },
          { status: 400 },
        );
      }
    }

    await prisma.user.update({
      where: { id: userId },
      data: {
        homeAssistantUrl,
        ...(homeAssistantToken && { homeAssistantToken }),
      },
    });

    return NextResponse.json({ success: true });
  },
);

export const DELETE = withAuth(
  "user/settings/home-assistant",
  async (request) => {
    await prisma.user.update({
      where: { id: request.auth.userId },
      data: { homeAssistantUrl: null, homeAssistantToken: null },
    });

    return NextResponse.json({ success: true });
  },
);
