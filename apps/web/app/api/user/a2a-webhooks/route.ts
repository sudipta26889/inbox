import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import crypto from "node:crypto";
import { getWebhookStats, WEBHOOK_EVENTS } from "@/utils/a2a/webhooks";

/**
 * A2A Webhook Configuration API
 *
 * Allows OAuth clients to configure webhooks for task state change notifications.
 *
 * GET /api/user/a2a-webhooks?clientId=<id> - Get webhook configuration
 * POST /api/user/a2a-webhooks - Create/update webhook configuration
 * DELETE /api/user/a2a-webhooks?clientId=<id> - Delete webhook configuration
 */

// Get webhook configuration for a client
export const GET = withAuth("user/a2a-webhooks", async (request) => {
  const { searchParams } = new URL(request.nextUrl);
  const clientId = searchParams.get("clientId");

  if (!clientId) {
    return NextResponse.json(
      { error: "clientId is required" },
      { status: 400 },
    );
  }

  // Verify client belongs to user
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId, userId: request.auth.userId },
  });

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Get webhook config
  const config = await prisma.a2aWebhookConfig.findUnique({
    where: { clientId },
  });

  if (!config) {
    return NextResponse.json(
      {
        clientId,
        configured: false,
        events: Object.values(WEBHOOK_EVENTS),
      },
      { status: 200 },
    );
  }

  // Get webhook stats
  const stats = await getWebhookStats(clientId, 7);

  return NextResponse.json({
    clientId,
    configured: true,
    url: config.url,
    enabled: config.enabled,
    events: config.events,
    stats,
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  });
});

export type GetWebhooksData = Awaited<ReturnType<typeof GET>>;

// Create or update webhook configuration
export const POST = withAuth("user/a2a-webhooks", async (request) => {
  const body = await request.json();
  const { clientId, url, events, enabled = true } = body;

  if (!clientId || !url) {
    return NextResponse.json(
      { error: "clientId and url are required" },
      { status: 400 },
    );
  }

  // Verify client belongs to user
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId, userId: request.auth.userId },
  });

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Validate URL
  try {
    new URL(url);
  } catch {
    return NextResponse.json({ error: "Invalid URL" }, { status: 400 });
  }

  // Validate events
  const validEvents = Object.values(WEBHOOK_EVENTS);
  const selectedEvents = events || validEvents;

  if (!Array.isArray(selectedEvents)) {
    return NextResponse.json(
      { error: "events must be an array" },
      { status: 400 },
    );
  }

  for (const event of selectedEvents) {
    if (!validEvents.includes(event)) {
      return NextResponse.json(
        { error: `Invalid event: ${event}` },
        { status: 400 },
      );
    }
  }

  // Generate webhook secret (random 32-byte hex string)
  const secret = crypto.randomBytes(32).toString("hex");

  // Create or update config
  const config = await prisma.a2aWebhookConfig.upsert({
    where: { clientId },
    create: {
      clientId,
      url,
      secret,
      enabled,
      events: selectedEvents,
    },
    update: {
      url,
      enabled,
      events: selectedEvents,
      // Keep existing secret unless explicitly regenerating
    },
  });

  return NextResponse.json({
    clientId: config.clientId,
    url: config.url,
    enabled: config.enabled,
    events: config.events,
    secret: config.secret, // Return secret only on create/update
    createdAt: config.createdAt,
    updatedAt: config.updatedAt,
  });
});

// Delete webhook configuration
export const DELETE = withAuth("user/a2a-webhooks", async (request) => {
  const { searchParams } = new URL(request.nextUrl);
  const clientId = searchParams.get("clientId");

  if (!clientId) {
    return NextResponse.json(
      { error: "clientId is required" },
      { status: 400 },
    );
  }

  // Verify client belongs to user
  const client = await prisma.mcpServerClient.findUnique({
    where: { clientId, userId: request.auth.userId },
  });

  if (!client) {
    return NextResponse.json({ error: "Client not found" }, { status: 404 });
  }

  // Delete webhook config
  await prisma.a2aWebhookConfig.delete({
    where: { clientId },
  });

  return NextResponse.json({ success: true });
});
