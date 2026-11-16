# Re-fork Inbox on current upstream

Status: v2, 2026-11-16, after EGM review (design; implementation readiness). Waiting for the owner's go on the
decisions below; no production change before the cut-over go. Supersedes `docs/designs/mail-ui-rebuild.md`.
Evidence: `.claude/scratchpad/2026-11-16-refork-inventory.md` (upstream `bc6b16d0b`, fork `3c9dbd4db`, merge-base
`59e496849`). Counts are re-taken at the branch cut (step 0).

## Goal
Inbox runs on current upstream: the mail client with the Mail / Assistant split, the unified "All Accounts" inbox on the
browser mail engine (sqlite-wasm on OPFS in a Web Worker, fed by `/api/mail/v1`), Tools and integrations, Channels, and
the new assistant and settings UI, with every fork customisation working. Afterwards upstream is merged regularly.

## Why re-fork (inventory numbers)
Upstream is ~2297 commits ahead of the merge-base, the fork ~566. The wanted features sit on upstream's provider, sync,
schema (66 models, ~134 migrations), better-auth 1.7 and AI SDK 7 rewrites, so porting them means porting most of
upstream. The fork's own code is 18 feature groups, ~90% in its own folders, hooking ~30 upstream files; its 168
backport files and docs drop out. Dry merge: 408 conflicting files, ~120 real customisation conflicts.

## Non-negotiables
- "Inbox" name and logo, no user-visible "Inbox Zero" in the UI, server output or outgoing mail templates.
- No billing, upgrade or trial UI; no analytics calls.
- Every outbound send passes DharaHIL (with `from`), including durable and scheduled sends, approved once.
- Shared mailboxes (`EmailAccountShare`, admin@) work everywhere, including the unified inbox and the sync API.
- Redis keys and channels only under `inbox:`; LLMs only via LiteLLM; never edit LiteLLM.
- Fan-out, TaskPilot, HA/MQTT, A2A, morning report, MCP server and its 73 tools keep working; existing MCP tokens keep
  working without reconnecting.
- Gmail push, the Outlook subscription and the 30-minute polling backup keep processing mail exactly once.

## Decisions (defaults; the owner confirms or changes)
1. **MCP OAuth**: keep the fork's `/mcp-server` server. Its `/.well-known/*` rewrites move into upstream's `proxy.ts`
   (Next 16 runs only one); upstream's `/mcp` is switched off by an env flag, not by deleting its files.
2. **Meeting recorder (Recall.ai) and billing**: in the code, switched off (no key, bypass on). Meetico stays separate.
3. **Desktop app and mobile push**: not built or shipped.
4. **Analytics**: PostHog keys unset, enforced by a test.
5. **Integrations/Tools**: `NEXT_PUBLIC_INTEGRATIONS_ENABLED=true` (the owner wants Tools); meeting briefs stay off.
6. **Cut-over**: one planned window on a weekend morning, length set by the rehearsal (target under 45 minutes).
   Rollback rule in "Cut-over".
7. **Morning report**: keeps the fork's sender at cut-over; Channels later.

## Plan
**Step 0, branch cut.** Fetch upstream; branch `refork/main` from `upstream/main@<sha recorded here>`; worktree
`.claude/worktrees/refork`. Freeze rule: no new migration on `sudipta_main` until cut-over; if one is unavoidable it is
copied into `refork/main` the same day. A per-commit list of the fork's ~539 non-merge, non-backport commits is made
from `git log 59e496849..sudipta_main`, each marked "upstream has it", "re-apply" (with its slice) or "drop"; slice
12 works through it.

**Slices** (one developer task each, tests first, reviewed and merged into `refork/main` before the next):
1. **Schema** (first, before anything boots against data): copy the fork's 21 unique migration folders byte-for-byte
   from `sudipta_main@<sha>`; merge its models into `schema.prisma`; `prisma validate`.
2. **Platform**: env branding; bypass; analytics test `__tests__/no-analytics.test.ts`; LiteLLM through upstream's
   `OPENAI_COMPATIBLE_*` and `*_LLMS` chains, with values carried from today's `DEFAULT_LLM_PROVIDER/MODEL` (the fork's
   `litellm` provider case is dropped if the chains cover it, kept otherwise; decided in this slice with a test);
   Redis `inbox:` prefix on every client (ioredis `keyPrefix`; BullMQ worker not deployed); `docker/scripts/start.sh`
   exits non-zero when `migrate deploy` fails or times out; deploy workflows (below). Proven locally only.
3. **DharaHIL gate** on every send path including durable and scheduled sends: approval happens before the operation
   or schedule is committed; idempotency key = operation id. Tests: an approved operation retried sends once and raises
   no second card; a scheduled send asks at scheduling time, not at 3 am; undo-send still works.
4. **Shared mailboxes** across upstream's routes, the `/api/mail/v1` sync API and All Accounts.
5. **MCP server + OAuth** (decision 1). Tests: discovery `issuer` and endpoints byte-identical to production today;
   a pre-cut-over access and refresh token (with `grantId`) call a tool and refresh.
6. **Mail ingestion continuity** (feature 7: polling backup, watch health, history catch-up) on upstream's webhook
   routes; Pub/Sub push path, verification token and Graph `notificationUrl` unchanged or migrated; every cron URL in
   `deploy/stack.yml` returns 2xx (crons stop using `|| true` for the status check).
7. A2A.  8. Fan-out.  9. TaskPilot (list UI rebuilt in the new mail UI).  10. HA/MQTT.  11. Morning report.
12. Jev (LiteLLM route and `DecisionModelRun` only), chat-memory supersession, overmind telemetry, `/api/v1`, email
    templates, typecheck ratchet, and every remaining "re-apply" commit from step 0's list.

**Each slice passes**: its tests; `pnpm -C apps/web exec tsc --noEmit -p tsconfig.build.json` exits 0; biome 0 errors;
the full suite with only the named known failures (`utils/taskpilot/llm.test.ts` callDecider ×5,
`utils/taskpilot/similar.test.ts` findSimilarTasksTopK); a strip-guard test that fails on "Inbox Zero" in UI, server
output and mail templates, and on billing names; one build or suite at a time on this machine (loadavg check first).

**Deploy workflows**: `.github/workflows/deploy-staging.yml` on push to `refork/main` builds
`ghcr.io/sudipta26889/inbox-web:refork-<short-sha>` (never `:latest`) and calls `secrets.PORTAINER_STAGING_WEBHOOK_URL`;
production `deploy.yml` is unchanged until cut-over.

## Rehearsal (production clone; the owner runs the privileged steps)
1. Owner, on db.lan as the production owner role: `pg_dump -Fc` of the production DB to a private path; `createdb
   inbox_refork_rehearsal`; `pg_restore --no-owner --role=inbox_rehearsal`; role `inbox_rehearsal` owns only that DB.
   Its URL goes in `apps/web/.env.rehearsal` (git-ignored, never echoed); used as file -> process only.
2. Before: production has no drift today (`migrate status` clean against `sudipta_main`'s migrations); exact
   `count(*)` of every table and Action rows per ActionType saved to `rehearsal-before.tsv`; grep of all upstream
   migration SQL for `_old`, `DROP`, `DELETE`, `UPDATE`, `TRUNCATE`, `SET NOT NULL`, each hit reviewed.
3. `migrate deploy` with production's config (`docker/scripts/prisma.config.ts`), timed; then `migrate status` up to
   date, no failed rows in `_prisma_migrations`, and `migrate diff` from the migrated database to the schema with
   `--exit-code` = 0 (flags checked against the installed Prisma first).
4. After: counts again; every table equal or explained by a reviewed data migration.
5. **Old image on the migrated clone**: boot today's production image read-only against the migrated clone and run its
   core paths (list rules, open MCP tool list). If it works, rollback is an image pin with no restore.
6. Drop the database, dump and role afterwards; restore a fresh copy for every rerun.

## Staging (isolated; never acts on real people or systems)
Stack `inbox-staging` (`deploy/stack.staging.yml`, host `inbox-staging.sudiptadhara.in`) on a freshly restored clone
in which every mailbox token except one test mailbox is cleared. Unset there: Pub/Sub topic and token, Telegram,
A2A fan-out and remote agents, MeetEcho, long-memory, MQTT, ntfy; no cron service (crons triggered by hand); its own
Valkey user and prefix `inbox-staging:`; DharaHIL with `DHARAHIL_ENVIRONMENT=staging` (cards marked staging); Mitra,
MeetEcho, TaskPilot and HA pointed at sandboxes or off. `AUTH_SECRET` and the email encryption keys are copied from
production so the cloned test mailbox decrypts. The owner adds the staging OAuth redirect URIs. Nothing runs against
cloned data before slice 3 is in.

## Cut-over
Gate (all pass/fail):
- Rehearsal steps 1-5 pass; migration time recorded and within the window.
- Staging: the test mailbox syncs into All Accounts; a send raises a staging DharaHIL card with `from`; MCP OAuth passes
  the PR 27 checks with a fresh client AND with a cloned pre-cut-over token; A2A, a fan-out, a TaskPilot conversion, an
  HA action and the morning report each succeed once against their sandboxes; strip guard and analytics test pass;
  Redis under `~inbox-staging:*` gives no NOPERM; a session cookie from the old image stays valid; Gmail and Outlook
  scope lists match today's (no re-consent); existing refresh tokens refresh.
- Owner says go.
Window: owner takes the `pg_dump`; set `IMAGE_TAG` pin to today's image; run `migrate deploy` by hand (owner,
production credentials) and check it; switch production `deploy.yml` to `refork/main`; deploy; clear the pin.
After: within 15 minutes, a test mail to each mailbox (incl. admin@) produces an ExecutedRule; mail that arrived during
the window is processed exactly once; MCP clients keep working; 24 h of ExecutedRule counts at least 70% of the same
weekday's average over the last 4 weeks.
Rollback: if rehearsal step 5 passed, pin the old image (no restore). Otherwise restore the dump only before T+2 h,
with webhooks and crons paused and history cursors moved forward; after T+2 h, roll forward.

## Owner actions needed
The six decisions; the production dump and rehearsal role (rehearsal step 1); the staging stack, Valkey user, DNS/edge
route and OAuth redirect URIs; `PORTAINER_STAGING_WEBHOOK_URL`; the cut-over go and window.
