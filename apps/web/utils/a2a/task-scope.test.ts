import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { taskScope } from "./task-scope";

const authContext = {
  userId: "user-1",
  emailAccountId: "acct-1",
  clientId: "a2a_peer_one",
  scopes: ["email:read"],
  tokenPayload: {},
} as unknown as Parameters<typeof taskScope>[0];

describe("task scope", () => {
  /**
   * All three, not just userId.
   *
   * Verified against production before this existed: a token for peer MeetEcho
   * read peer OpenClaw's task input and results, then cancelled one of its
   * in-flight tasks. Both peers belong to the same user, and the token was
   * bound to a different email account than the task — so filtering on userId
   * alone failed at the peer boundary AND the account boundary at once.
   */
  it("bounds a query by user, account and peer", () => {
    expect(taskScope(authContext)).toEqual({
      userId: "user-1",
      emailAccountId: "acct-1",
      clientId: "a2a_peer_one",
    });
  });
});

/**
 * Structural guard. The failure being prevented is a handler added later that
 * filters on userId alone — which is how every one of these ended up wrong.
 * Asserted over the source because no mock can catch a query that was never
 * written.
 */
describe("every task query is scoped", () => {
  const files = [
    "utils/a2a/protocol-handler.ts",
    "app/a2a/stream/route.ts",
    "app/a2a/route.ts",
    "utils/a2a/push-config.ts",
  ];

  for (const file of files) {
    it(`${file} filters tasks through taskScope`, () => {
      const source = readFileSync(join(process.cwd(), file), "utf8");

      const queries =
        source.match(/prisma\.a2aTask\.(findUnique|findFirst|findMany)\(/g) ??
        [];

      if (queries.length === 0) return;

      const scoped = source.split("...taskScope(").length - 1;

      // A lookup by the internal row id is already authorized: that id is only
      // ever obtained from a scoped read earlier in the same request, and it is
      // not a value a caller can supply — the protocol speaks in `taskId`.
      // Anchored to `a2aTask` specifically — an unrelated model's by-id call
      // elsewhere in the same file (e.g. `a2aWebhookConfig.update({ where: {
      // id } })`) must not be able to stand in for scoping a task query.
      //
      // Restricted to the SAME method set as `queries` above (find* only) —
      // not `\w+`. A mutation (`update`/`delete`) by internal id is not one
      // of the queries this guard counts in the first place, so it must not
      // earn slack either: that let `handleTaskCancel`'s
      // `prisma.a2aTask.update({ where: { id: task.id } })` mask a deleted
      // `...taskScope(authContext)` on the scoped read a few lines above it.
      const byInternalId =
        source.match(
          /prisma\.a2aTask\.(findUnique|findFirst|findMany)\(\s*\{\s*where:\s*\{\s*id:\s*[A-Za-z.]+\s*\}/g,
        )?.length ?? 0;

      expect(
        scoped + byInternalId,
        `${file} has ${queries.length} task query/queries, ${scoped} scoped and ${byInternalId} by internal id`,
      ).toBeGreaterThanOrEqual(queries.length);
    });
  }

  it("no task query filters on userId alone", () => {
    for (const file of files) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      const filters = source.match(
        /where: \{[^}]*userId: auth(Context|Result)\.userId[^}]*\}/g,
      );

      expect(
        filters,
        `${file} filters tasks on userId without the account and peer bounds`,
      ).toBeNull();
    }
  });
});
