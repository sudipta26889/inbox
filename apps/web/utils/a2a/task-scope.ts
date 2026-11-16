import "server-only";
import type { A2aAuthContext } from "@/utils/a2a/auth";

/**
 * The boundary a caller's task queries must not reach past.
 *
 * Every task handler used to filter on `userId` alone, which is not the
 * caller's boundary — it is the boundary of the human who happens to own the
 * credential. Verified against production before this existed: a token for peer
 * MeetEcho read peer OpenClaw's task input and results in full, and then
 * cancelled one of its in-flight tasks. Both peers belong to the same user, and
 * the token was bound to a different email account than the task, so two
 * separations failed at once.
 *
 * A2A v1.0 §13.1 is unusually blunt about this: implementations "MUST scope
 * results to the caller's authorized boundaries even when contextId or other
 * filters are absent", and the check "MUST occur before any database query that
 * could leak the existence of out-of-scope resources".
 *
 * Returned as a spreadable filter rather than left to each handler, because the
 * failure mode is a new handler that simply forgets one of the three — which is
 * exactly how these ended up with only `userId`.
 */
export function taskScope(authContext: A2aAuthContext): {
  userId: string;
  emailAccountId: string;
  clientId: string;
} {
  return {
    userId: authContext.userId,
    emailAccountId: authContext.emailAccountId,
    // Peer-level isolation. A client id is stable across token rotation, so a
    // peer keeps access to its own tasks while never gaining another's.
    clientId: authContext.clientId,
  };
}
