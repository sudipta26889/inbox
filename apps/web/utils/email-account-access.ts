import { NextResponse } from "next/server";
import { SafeError } from "@/utils/error";

export const OWNER_ONLY_MESSAGE =
  "Only the account owner can do this. Ask the owner of this mailbox.";

/** Prisma filter: email accounts the user owns or has been shared. */
export function accessibleEmailAccountWhere(userId: string) {
  return { OR: [{ userId }, { shares: { some: { userId } } }] };
}

/**
 * Shared users act as the owner, so `ownerUserId` is ctx.userId / auth.userId and
 * `sessionUserId` is who is signed in. Anything that grants access outliving a
 * share (API keys, chat links, custom MCP servers, org enrolment) must call this.
 */
export function assertAccountOwner({
  ownerUserId,
  sessionUserId,
}: {
  ownerUserId: string;
  sessionUserId: string | undefined;
}) {
  if (!sessionUserId || ownerUserId !== sessionUserId) {
    throw new SafeError(OWNER_ONLY_MESSAGE);
  }
}

/**
 * Route form of assertAccountOwner for withEmailAccount routes that start a
 * connection (Slack, Drive, Calendar, MCP integrations), which outlives a share.
 */
export function sharedUserRefusal(auth: {
  userId: string;
  actorUserId: string;
}) {
  if (auth.userId === auth.actorUserId) return null;
  return NextResponse.json(
    { error: OWNER_ONLY_MESSAGE, isKnownError: true },
    { status: 403 },
  );
}
