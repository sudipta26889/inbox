import "server-only";
import { createHash } from "node:crypto";
import { A2aApprovalStatus } from "@/generated/prisma/enums";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";

/**
 * Recognising an action a human has already approved.
 *
 * calendar.create_event used to prompt twice for one event: the A2A layer
 * parked the task and raised a DharaHIL request, then the tool that finally ran
 * raised a second, independent one. Same gateway, same human, same event, no
 * signal connecting them — because the two requests shared no identity. One
 * keyed itself `calendar_${title}_${startTime}_${Date.now()}`, which, with a
 * clock in it, can never match anything. That is a correlation id wearing an
 * idempotency key's name.
 *
 * The fix is NOT a skipApproval flag threaded down the stack. A bypass
 * parameter is bypassable by construction: anything that can call the tool can
 * set it. Instead the gate looks up a durable decision recorded against the
 * canonical identity of the action, so the only way to skip a prompt is for a
 * human to have genuinely approved this exact action already.
 */

/**
 * Canonical identity of an action: same action, same key, whoever asks.
 *
 * Deliberately conservative — a key that differs when it shouldn't costs an
 * extra approval prompt, while a key that matches when it shouldn't skips one.
 * Only the first of those is survivable, so normalization stays minimal: trim
 * strings, sort primitive arrays (attendee order is not part of the action's
 * identity), drop null/undefined, and leave case alone.
 */
export function canonicalActionKey({
  userId,
  emailAccountId,
  operation,
  args,
}: {
  userId: string;
  emailAccountId: string;
  /** The MCP tool name, so the A2A skill and the tool agree on one spelling. */
  operation: string;
  args: unknown;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([userId, emailAccountId, operation, canonicalize(args)]),
    )
    .digest("hex");
}

function canonicalize(value: unknown): unknown {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) {
    const items = value.map(canonicalize);
    // Sorted only when every element is a primitive: those arrays are sets
    // (attendees, labels) where order carries no meaning. An array of objects
    // might be an ordered list, so it is left alone.
    return items.every((item) => item === null || typeof item !== "object")
      ? [...items].sort((a, b) => String(a).localeCompare(String(b)))
      : items;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, canonicalize(entry)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return value;
}

/**
 * Spend a human decision that already authorizes this exact action.
 *
 * Returns true only if an approved, unconsumed decision existed — and marks it
 * consumed in the same statement. Single-use is the point: one approval
 * authorizes one execution, so a retried task, or a peer resubmitting an
 * identical event, cannot inherit an earlier "yes".
 *
 * The conditional UPDATE is the compare-and-swap. Under READ COMMITTED a second
 * concurrent caller blocks on the row lock, re-evaluates once the first commits,
 * no longer matches `consumedAt: null`, and gets a count of 0.
 */
export async function consumeApprovedDecision({
  actionKey,
  logger,
}: {
  actionKey: string;
  logger: Logger;
}): Promise<boolean> {
  const { count } = await prisma.a2aApproval.updateMany({
    where: {
      actionKey,
      status: A2aApprovalStatus.approved,
      consumedAt: null,
    },
    data: { consumedAt: new Date() },
  });

  if (count > 0) {
    logger.info("Proceeding on a decision a human already made", { actionKey });
    return true;
  }

  return false;
}
