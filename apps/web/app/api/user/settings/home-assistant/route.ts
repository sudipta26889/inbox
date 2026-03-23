import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

const homeAssistantSchema = z.object({
  homeAssistantUrl: z.string().url().min(1),
  homeAssistantToken: z.string().min(1),
});

export const POST = withAuth(
  "user/settings/home-assistant",
  async (request) => {
    try {
      const body = await request.json();
      const { homeAssistantUrl, homeAssistantToken } =
        homeAssistantSchema.parse(body);

      const userId = request.auth.userId;

      // Update user settings
      await prisma.user.update({
        where: { id: userId },
        data: {
          homeAssistantUrl,
          homeAssistantToken,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return NextResponse.json(
          { error: "Invalid input", details: error.errors },
          { status: 400 },
        );
      }

      console.error("Error saving Home Assistant settings:", error);
      return NextResponse.json(
        { error: "Failed to save settings" },
        { status: 500 },
      );
    }
  },
);

export const DELETE = withAuth(
  "user/settings/home-assistant",
  async (request) => {
    try {
      const userId = request.auth.userId;

      // Remove Home Assistant settings
      await prisma.user.update({
        where: { id: userId },
        data: {
          homeAssistantUrl: null,
          homeAssistantToken: null,
        },
      });

      return NextResponse.json({ success: true });
    } catch (error) {
      console.error("Error disconnecting Home Assistant:", error);
      return NextResponse.json(
        { error: "Failed to disconnect" },
        { status: 500 },
      );
    }
  },
);
