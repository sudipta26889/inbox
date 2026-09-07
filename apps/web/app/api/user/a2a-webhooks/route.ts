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

  // This route predates A2A §3.1.7 per-task config; it only ever manages the
  // client-level default (taskId NULL). Prisma's compound-unique input can't
  // carry null (SQL equality never matches NULL), so this is a plain filter
  // rather than findUnique.
  const config = await prisma.a2aWebhookConfig.findFirst({
    where: { clientId, taskId: null },
  });

  if (!config) {
    // No client-level default, but a peer may have created a task-specific
    // row via pushconfig.set (A2A §3.1.7) — that still delivers, so
    // `configured` must reflect it even though the rest of this response
    // describes the (missing) client-default row.
    const anyRow = await prisma.a2aWebhookConfig.count({
      where: { clientId },
    });
    return NextResponse.json(
      {
        clientId,
        configured: anyRow > 0,
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

  // Create or update config. This route predates A2A §3.1.7 per-task config; it
  // only ever manages the client-level default (taskId NULL). Prisma's
  // compound-unique input can't carry null, so this can't be an atomic
  // upsert — find the existing default row, then create or update by id.
  const existingConfig = await prisma.a2aWebhookConfig.findFirst({
    where: { clientId, taskId: null },
  });

  const config = existingConfig
    ? await prisma.a2aWebhookConfig.update({
        where: { id: existingConfig.id },
        data: {
          url,
          enabled,
          events: selectedEvents,
          // Keep existing secret unless explicitly regenerating
        },
      })
    : await prisma.a2aWebhookConfig.create({
        data: {
          clientId,
          taskId: null,
          url,
          secret,
          enabled,
          events: selectedEvents,
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

  // This is the owner's kill switch, so it has to stop delivery outright —
  // not just for the client-level default this route predates A2A §3.1.7
  // per-task config to manage. A peer can create task-specific rows via
  // pushconfig.set (see push-config.ts), and queueWebhook only suppresses
  // those when a *disabled* default row exists — with no default row at
  // all, a task-specific row still delivers. Deleting every row for this
  // client, not just taskId: null, is the simplest way to guarantee nothing
  // is left that would still fire, and it keeps this GET route's
  // `configured` answer accurate (no rows left means nothing to deliver).
  const result = await prisma.a2aWebhookConfig.deleteMany({
    where: { clientId },
  });

  if (result.count === 0) {
    return NextResponse.json(
      { error: "Webhook config not found" },
      { status: 404 },
    );
  }

  return NextResponse.json({ success: true });
});
