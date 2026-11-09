# Upstream sync log

This fork tracks [elie222/inbox-zero](https://github.com/elie222/inbox-zero)
the way a distro stable branch tracks mainline: no merges, no rebases — only
targeted backports of individual fixes, cherry-picked with `-x` so every
commit records its upstream SHA.

Conventions:

- `UPSTREAM:` subject prefix — applied as-is (clean cherry-pick).
- `BACKPORT:` subject prefix — adapted to this fork's code (conflicts resolved
  or hand-ported); the upstream SHA is still cited in the message.
- Check whether an upstream fix is already here: `git log --grep=<upstream-sha>`.
- Local tags: `upstream-base` (fork divergence point), `upstream-audit/YYYY-MM-DD`
  (upstream/main SHA at each audit).
- Branches: `main` follows upstream when the owner syncs the fork, so it is no longer
  frozen at `upstream-base`, which stays a fixed tag at 59e4968495d5. A sync runs upstream's
  push workflows on `main`, and some of them fail here for lack of secrets. Never commit
  or open PRs against `main`. All fork work goes on `sudipta_main`, which is the deployed
  branch. A PR merged to `main` does not reach production.
- Repo config: `rerere.enabled` + `merge.conflictStyle=zdiff3` are set, so
  recurring conflicts resolve themselves on the second occurrence.

Next audit: `git fetch upstream && git log --oneline -i -E --grep='security|CVE|vuln|xss|csrf|ssrf|injection|sanitiz|auth' upstream-audit/<last>..upstream/main`
Also check the upstream repo's GitHub Security tab, and run `pnpm audit` —
for this stack most real CVEs are in dependencies, not app code.

---

## Audit 2026-11-05

Range reviewed: `upstream-audit/2026-10-12` (41179be9f) → `upstream-audit/2026-11-05`
(f2d956756) — 328 non-merge commits. Read-only triage; nothing picked yet. Picks that change
production need the owner's go, and none land until the morning checks after the Portainer move
pass. Of the 89 commits touching send, auth, webhook and Gmail paths, diffs were read only for
those named here; the rest were judged from file lists and subjects, so a miss could hide there.

### Queued

| Batch | Upstream | Why |
|---|---|---|
| 0 | fork-local | Request body limits on public routes, plus a dependency override |
| 1 | 1797f8438, ffd9f3015, f2d956756 | Next.js 16.4.x: Server Actions DoS GHSA-p3m5-59mp-jv5r; also brings `sharp` 0.35.5. nodemailer 10.3.1 and dompurify 3.4.x in the same pass |
| 2 | c1fe110bb, b1495f9b4 | Reply actions drop configured CC and BCC; manual replies ignore Reply-To |
| 3 | 46604b2f0, 77aaed168 | A learned sender also matches lookalike domains and skips the AI. Check rules for a literal pipe first, since 77aaed168 changes how they match |
| 6 | d06bd235a, 2e78381d1, 7a80641cf, dc4aef03f, 7e7d313c5, 198ba7fe8, 080bdada6, 5f36395cf | Weekly digests on the chosen weekday, one digest after a stale schedule, scheduled runs skip disconnected accounts, rule-history retry, small error and log-level fixes |

### Picked (batch 6 — schedules, reconnects, small fixes, branch `backport/schedules-reconnects`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| d06bd235a | #4224 | Weekly digests on the chosen weekday | UPSTREAM (clean cherry-pick) |
| 2e78381d1 | #4363 | One digest after a stale schedule, not one per cron run | BACKPORT. Fork's `digest/schedule.ts` has no `DIGEST_DISPATCH_INTERVAL_MINUTES`, so only the catch-up loop and its cap came over |
| 7a80641cf | #4433 | Scheduled runs skip disconnected email accounts | BACKPORT. Only `execute.ts` changed; the fork-local check-in files (`message.ts`, `messaging.ts`, `generate-check-in-message.ts`) are untouched. The fork had no `execute.test.ts`, so a one-case test is new (the upstream route cases need `MessagingRoute*`, which the fork lacks) |
| dc4aef03f | #4209 | Commas kept inside List-Unsubscribe URLs not listed first | UPSTREAM (clean cherry-pick) |
| 7e7d313c5 | #4324 | Retry rule history insert on version conflict | BACKPORT. Test fitted to the fork's older snapshot shape (no messaging-channel fields) |
| 198ba7fe8 | #4229 | Fewer production errors | BACKPORT, hand-ported. Taken: nested Gmail insufficient-scope detection, unusable Outlook mailbox as a known error, signed-out redirect in `checkUserOwnsEmailAccount`, invalid-model error marked handled for user keys, one email provider per onboarding rule creation. **Migration, `schema.prisma`, the better-auth patch and lockfile dropped** (no `ExecutedRule` index). Dropped: `assistant-state` cursor (file absent), `(app)/layout.tsx` last-login (fork already updates by id), auth startup seed (fork's auth predates it) |
| 080bdada6 | #4312 | Log expected account states as warnings | BACKPORT, log levels only. Adds `level` to `logErrorWithDedupe`; known API and user-key errors log as warnings in `process-history-item.ts` and the Gmail `process-history.ts`; reply-tracker SafeErrors, 4xx queue forwards and invalid referral codes no longer log as errors or reach Sentry. Dropped: skip-disconnected snooze (no snooze module), draft-cleanup (fork lacks `cleanupConfiguredAIDraftsForAccount`), account-delete timeout (fork deletes without a transaction), client Sentry filters, `swr-fetcher` |
| 5f36395cf | #3409 | Hide the upgrade prompt when premium checks are bypassed | BACKPORT. `PremiumCard` returns nothing when `NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS` is on (it is built `true` in `deploy.yml`). No pricing or "Inbox Zero" text added |

### Picked (batch 4 — clean and bulk safety, branch `backport/clean-bulk-safety`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 4ff20cce3 | #4342 | Clean keeps starred and replied threads that start with a newsletter | BACKPORT. Upstream's `controller.ts` is `route.ts` here. Keep checks run over every message before the archive shortcuts (unsubscribe link, newsletter sender, past invite). Upstream's tests brought along |
| 269b53693 | #4380 | Bulk archive from a sender reaches every page | BACKPORT. `archiveMessagesFromSenders` lists all pages first, then archives; the fork has no `continueOnError`, so errors are still logged and skipped as before. New `bulkArchiveFromSenders` test pages like Gmail does |
| 900dbe217 | #4213 | Deep Clean pages through the inbox instead of refetching page one | BACKPORT. Fix is in `processCleanupJob` in `utils/clean/domain.ts` (the MCP/`admin_cleanup_create_job` path); `cleanInboxAction` has no paging loop here. Test goes through `createCleanupJob` |
| a13426c55 | #4362 | A sender's filter no longer matches another sender's address | BACKPORT. Fork has no `utils/senders/filters.ts`; the match is `findAutoArchiveFilter` in `app/api/user/stats/newsletters/helpers.ts`. New `helpers.test.ts` |
| d14e87777 | #4474 | Match semicolon-separated senders in Gmail filter criteria | BACKPORT. Same file; splits on `;` and quotes too. Upstream also dropped display-name matching in filters, which this fork's version never had |

### Picked (batch 5 — drafts, branch `backport/drafts`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 3b522a384 | #4383 | Stop cutting emails at an inline "original message" | BACKPORT. Only a separator line counts as an Outlook or iOS marker, and the earliest marker wins. The fork's `removeForwardedContent` is in `utils/mail.ts`. The linear-time test is not ported: `removeExcessiveWhitespace` itself is slow on a very long whitespace run (pre-existing) |
| d6c4011ea | #4391 | HTML signatures keep their spacing in Gmail drafts | BACKPORT. `renderReplyBodyHtml` (new, shared with Outlook) puts line breaks on top-level text only; wired into Gmail `replyToEmail`, `draftEmail` and the plain-text alternative. Test shows text already escaped by 15d8737c5 / `renderEmailTextWithSafeLinks` is not escaped twice |
| 1161cc340 | #4262 | Keep the signature a signature in AI draft replies | BACKPORT, adapted: the fork has no `reply-body.ts`, so `wrapSignature` is applied in the reply-tracker and follow-up `generate-draft.ts` |
| 09b2eb3a2 | #4218 | Answer each of a sender's separate questions on its own | BACKPORT, prompt line only; `DRAFT_PIPELINE_VERSION` 2 to 3. The upstream eval is not ported (the fork's eval file lacks its helpers) |
| 9869d25ae | #4313 | Concurrent draft send logs | BACKPORT, draft half only (summary email route durations skipped). Adapted to `wasDraftSent`; new `draft-tracking.test.ts` |

### Picked (batch 3 — rules acting on the wrong mail, branch `backport/rules-wrong-mail`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 77aaed168 | #4208 | `\|` in subject/body static conditions is literal | UPSTREAM. Production rules use `\|` only in From conditions, which are split before matching, so none change |
| 46604b2f0 | #4288 | Learned sender patterns match the whole address | BACKPORT. Adds `utils/rule/email-from-pattern.ts` (helpers moved out of `match-rules.ts`). A learned display name still matches anywhere in From |
| c83ca6612 | #4151 | Resolve rule names with leaked JSON characters | BACKPORT. Fork's `aiChooseRule` has no result logging or classification feedback; new `ai-choose-rule.test.ts` |
| 38bf57535 | #4237 | Resolve rule names followed by extra words | BACKPORT (logging-only conflict) |
| 4128ed234 | #4255 | Surface an AI match that names no offered rule | BACKPORT. Adapted to log an error and return no match instead of throwing, so skipped emails still get their skipped record and fan-out |
| 5a6fd0c8a | #4290 | Static body conditions match HTML-only emails | BACKPORT. Only the new options added to the fork's older `convertEmailHtmlToText` |
| 2f4ff6ac1 | #4343 | Actions with an unsupported delay run now instead of being dropped | BACKPORT. Guard in the fork's `mapActionFields` |
| 435482eff | #4266 | Delayed actions keep `labelId` | BACKPORT. Move-to-folder half dropped (Outlook only) |
| b4a25c631 | #4361 | "Not a cold email" honoured regardless of sender address case | BACKPORT. Gmail label handlers are under `app/api/google/webhook/` here |

### Picked (batch 2 — Gmail history pointer, branch `fix/gmail-pointer`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 7e0325690 | #3957 | Catch up on rate-limited Gmail history | BACKPORT, history half only; the follow-up scan half is skipped (already bounded here). A rate limit on an item stops the batch, the pointer advances per history entry, and the catch-up window is 30,000 IDs (normal window stays 500). The marker is cleared with a plain `redis.del`, not an owned-lock token, and kept while Gmail reports more history pages, since the fork fetches one page. Marked in `process-history.ts`; the fork's `route.ts` does no rate-limit check of its own |
| dfb122fbb | #4268 | Release the message lock on failure; skip inbound mail over 24 hours old | BACKPORT, Gmail and shared parts. `withMessageProcessingLock` wraps `markMessageAsProcessing` and deletes the key on failure. The 24-hour guard sits after sent-mail and filebot handling. Outlook parts dropped; Outlook still calls `markMessageAsProcessing` |
| e090cba4a | #4424 | Stop Gmail history processing once the account loses credentials | BACKPORT. Only `classifyEmailAccountProviderIssue` is ported into `utils/email/provider-health.ts`, without the rest of that module or Outlook's AADSTS marker |
| fork-local | — | The 30-minute poller never overwrites the pointer | `process-account.ts` wrote Gmail's current history ID after every run, which skipped whatever the webhook had held back. It now seeds only a null pointer, skips Gmail during an active rate limit, and takes the same message lock as the webhook |

### Picked (batch 2 — reply recipients, branch `fix/reply-cc-bcc-replyto`)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| c1fe110bb | #4210 | Send the CC and BCC configured on a Reply action | BACKPORT. `replyToEmail` takes `cc`/`bcc` on the provider interface, Gmail and Outlook; the reply action passes them. Tests re-fitted to the fork's files; the Outlook reply test is dropped (no reply scaffolding in the fork's Outlook test) |
| b1495f9b4 | #4279 | Address replies to the sender's Reply-To address | BACKPORT. Manual Reply in `EmailMessage.tsx` prefers Reply-To; `reply-all.ts` leaves every Reply-To address out of CC (adapted to the fork's single-user signature). The fork had no `EmailMessage.test.tsx` and no offline Playwright spec, so a small component test is new and the spec change is dropped |

### Evaluated and skipped

- b9d34880a calendar reconnect tokens: the fork already updates tokens on re-authorisation (7a338ca9c) with its own message `calendar_reconnected` and flow; upstream's test does not fit that flow. No change.
- 1035b044b better-auth 1.7: needs an `Account` migration. Stay on 1.6.x. GHSA-4wq4-2ppv-q3hg, which it cites, returned 404, so its effect on 1.6 is unknown.
- d181112bc zod 4 migration: a major migration; the override above covers the reachable path.
- 8516acfb8 prisma: deepmerge-ts and mysql2 are not reachable here.
- a7b2392c6 MCP SDK: fixes nothing reachable. `/mcp-server` is a hand-written handler the SDK never sees, though it parses the body before authenticating, which the edge limit covers.
- 933f88876 cold email back to the LLM: upstream's evals could not separate personalised pitches from real outreach, with no numbers given. Jev stays as it is unless the owner decides otherwise.

**Correction to the 2026-10-12 audit:** 7e0325690 was skipped because `lastSyncedHistoryId` is not advanced on a rate-limit skip. That holds only when a whole webhook is skipped at the start. `processHistory` catches per-item errors and still advances the pointer at the end of the batch. Before applying, check whether rate-limit errors actually surface on per-item calls.

## Audit 2026-10-12

Range reviewed: `upstream-audit/2026-09-14` (57e47b283) → `upstream-audit/2026-10-12`
(41179be9f) — 403 commits. Triage complete; backports land in batches.

Shape: 119 mail UI, 33 billing/marketing, 22 CI/docs, 19 Outlook, 15 desktop/mobile,
11 meetings/calendar, 14 LLM/provider, 6 decision-model, 6 onboarding, 5 orgs, 153 other.
Upstream also shipped a new SQLite mail engine (`f55fd1069` and ~20 `mail-sqlite`/
`mail-engine` follow-ups) — skipped wholesale with the mail UI.

### Picked (batch 1 — security, deployed 2026-10-12)

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| acf9fc39f, 127845990 | #3901, #3991 | Next.js 16.3.6 → 16.3.8 (next/og RCE) | version bump |
| c4edc8550 | #3903 | Nodemailer 10.0.13 | version bump; address-comment test ported |
| 4cbf34cbc, c03a06e3f | #3968, #3944 | proxy-addr / undici advisories | overrides, plus upstream's other CVE pins present in this tree |
| 854b86bce | #4001 | mammoth ReDoS | version bump |
| 405092ca4 | #3373 | Preserve forwarded content and Bcc recipients | BACKPORT — **missed in the 2026-09-14 audit** (landed 2026-08-24). Bcc recipients were silently never delivered on Gmail sends; plain-text forwards lost their body. Added an escaping `textToHtmlParagraphs`. |

### Queued

**Batch 2a — Jev decision layer: LANDED** 25380f5f6 (BACKPORT of 063caf0a6 + 603dc322b) —
cold-email, thread-status, categorize-sender (single + bulk), recurring-pattern, all in shadow mode.

**Batch 2b — Jev rule choice: LANDED in shadow (2026-10-12)** — `decision-model/choose-rule.ts`,
adapted from upstream's: no cold-email question (the fork decides cold email first)
and no classification feedback (the fork has none; upstream treats it as optional).
Multi-rule selection stays with the LLM, as upstream. Feature `choose-rule`, not in
DECISION_MODEL_LIVE. Same day: thread-status, cold-email and categorize-sender went
LIVE at DECISION_MIN_CONFIDENCE=0.95 with an LLM audit of every live decision.
b73797a3b #3791, d87dca417 #3807, 063caf0a6 #3806, 245ad1d13 #4028, 603dc322b #4057 —
adapted: System One fetch shim instead of AI SDK 7, plus shadow mode, a
deepseek-v4-flash escalation band and lazy explanations. Prereq candidates:
6a0cf8085 #3787 (conversation statuses on the rule), 151da383b #3817.

**Batch 3 — security hardening: DONE**

| Upstream | PR | Outcome |
|---|---|---|
| 64830555b | #3798 | BACKPORT a8bc87e3a — attachments always served as `application/octet-stream` + `nosniff`, filename ASCII-sanitised with RFC 5987 name. Preview half N/A (fork has no previews). |
| ccee1bcfa | #3918 | BACKPORT 15d8737c5 — escapes the quoted plain-text original (Gmail + Outlook), AI-filled template vars in DRAFT_EMAIL/REPLY, the assistant's confirmed reply, and filing-bot replies. AI drafts were already escaped. |
| b2ceb6645 + 3438e6682 | #2123 + #3919 | BACKPORT 092dd68a6 — webhooks connect only to the addresses validation vetted (no DNS rebinding) and never follow redirects. **Missed by the 2026-08-05 audit** (it took the save-time half, #2141). |
| 908d2170c | #3724 | Skipped — guards sessions from upstream's email-code sign-in (#3608), which the fork doesn't have; the fork's local auth bypass is hard-gated to NODE_ENV=development. |
| 6e1d0cd73 | #4109 | Skipped — the fork's MCP admin write tools carry no annotations, so they already default to destructive + open-world per the MCP spec; upstream's bug was an explicit `destructiveHint: false`. |
| 33dbb2b6e | #3809 | Skipped — inline `data:` profile photos come from Microsoft sign-in; Gmail-only instance, 0 of 5 users have one. Revisit if an Outlook account is connected. |
| 8988e25bf | #3708 | Moved to batch 5 — reconnect binding is a correctness fix across the OAuth flow that needs a browser walkthrough, not a security fix. |

**Batch 4 — AI quality: DONE**

| Upstream | PR | Outcome |
|---|---|---|
| fcdc49dd0 + b7fd5f5b1 | #3910, #3928 | BACKPORT 609f64a7d — drafts answer as the user instead of "I'll check and get back to you"; never guess availability (the fork already forbade it). Targeted rules only: upstream's draft prompt has ~27 revisions the fork lacks. DRAFT_PIPELINE_VERSION 1 → 2. |
| fe0a3be14 | #4077 | BACKPORT b3de7ff93 — assistant replies/forwards in the email's language, not the chat's. |
| d55c1a5b2 | #3880 | BACKPORT e899761df — trim stale tool results in long agent loops; composed with the fork's finalStepMustAnswer in utils/llms. |
| 05fafcd71 | #3953 | BACKPORT 1d1ba3640 — readable cold-email match reasons; long rule instructions clamped in the UI. |
| 598c23c68 | #3803 | BACKPORT 0f98c94b2 — hidden email context labelled untrusted (prompt-injection guard); create-rule asks for the action when unspecified. |
| e2c81ed5a | #4010 | BACKPORT 7e650a00b — "Not cold email" removes the label from archived mail (Gmail queries defaulted to the inbox), paginated to 500. |
| 2b53b4083 | #3805 | BACKPORT be0e39338 — custom-rule label removals drop the AI sender pattern that kept re-adding the label. Cleanup migration not ported (needs ClassificationFeedback). |
| 0488af760 | #3808 | UPSTREAM ef47e60ff — bulk sender categorization keeps going past a bad sender. |
| bd29cb7ad | #3993 | BACKPORT aca657174 — surrogate-safe truncation; also applied to the Jev email state. |
| 7944319be | #3950 | BACKPORT e37375d7e — script part only: `\p{M}` kept so Bengali/Hindi words aren't split at vowel signs (draft-attachment search, slugify). |
| db610cb26 | #3804 | Skipped — enabling chat-created rules immediately relies on upstream's chat confirmation flow (assistant-chat-confirmation.ts) the fork lacks; porting it alone removes a safety gate. |
| 8ababe876 | #4017 | Skipped — provider prompt-cache markers do nothing on the fork's LiteLLM/Ollama models. |
| ab32fac01 | #3794 | Skipped — self-hoster opt-out for pattern learning; not wanted. |
| 784fccc09 | #3973 | N/A — fork has no sender-stats.ts. |
| 2571ce497 | #3795 | Deferred — filebot emails in thread status; 0 filings ever on this instance. Revisit if Drive filing is used. |

**Batch 5 — Gmail and mail reliability: DONE**

| Upstream | PR | Outcome |
|---|---|---|
| b12ad9283 | #4027 | BACKPORT 138fb4c31 — Apple Mail messages show the whole body, not only the signature part. |
| 47b75e015 | #3861 | BACKPORT 4954b3c41 — `isDuplicateError` reads the pg adapter's constraint (fields or 63-char-truncated index name); all 8 keyed callers always returned false under `@prisma/adapter-pg`. |
| 20acbdfa4 | #4037 | UPSTREAM d586e2dbb — a chat refetch no longer drops the in-progress assistant reply. |
| 7e0325690 | #3957 | Skipped — the fork's follow-up scan is already bounded at 50, and `lastSyncedHistoryId` isn't advanced on a rate-limit skip, so no mail is lost. |
| 071c11d81 | #4033 | Skipped — needs upstream's provider-health module; the AI half is OpenAI-quota-specific (fork runs on LiteLLM). |
| f801fff94 | #3875 | Skipped — reuses upstream's sign-in rename flow (`utils/auth/rename-email.ts`), which the fork doesn't have; Workspace address renames are rare here. |
| a8f96364b | #3922 | Skipped — refactor of the Microsoft retry loop; Gmail-only instance, and Retry-After parsing is already covered by the fork's #3097 backport. |
| 721abd362 | #4063 | Skipped — mostly meeting-recorder media cleanup; the fork has no meeting recorder. |
| 55a566fe7, 41fbcda08, 787458314, 26eaed10e | #3985, #3749, #4112, #4038 | Skipped — tied to upstream's rewritten mail/draft UI, email-editor package and resumable-chat transport (new deps); none apply cleanly to the fork's UI. |
| 8988e25bf | #3708 | BACKPORT 8b79a57c3 — ported by hand onto the fork's cookie-compared OAuth state (upstream uses signed state). Permissions-page reconnect sends login_hint and the callback refuses a different account. To verify on Sudipta's pending account reconnections. |

**Separate decision — AI SDK 7** (074e09680 #3703, 93 files). Not required for Jev
(see batch 2). Take it only if a later backport needs SDK 7 APIs.

### Skipped wholesale (additions)

- SQLite mail engine and its follow-ups; Composio/Pipedream/custom-MCP integrations
  (integrations are disabled here); isolated browser unsubscribe worker; voice;
  native iOS/APNs/StoreKit/emulator; cookie consent banner; Reply Zero page removal
  (2b08584b4 — the fork keeps the page); loops/trial events; Tinybird datasource cleanup.

---

## Audit 2026-09-14

Range reviewed: `upstream-audit/2026-08-05` (10b19ebea) → `upstream-audit/2026-09-14`
(57e47b283) — 484 commits.

### Dependency CVEs (version bumps, not cherry-picks)

`pnpm audit` mattered more than any single upstream commit this round: 9 criticals,
four of them live. These are plain version changes, so they carry no upstream SHA
and no `UPSTREAM:`/`BACKPORT:` prefix.

| Change | Why |
|---|---|
| next 16.1.6 → 16.3.4 (+ `pnpm.overrides`) | CVE-2026-75604 / GHSA-2xp9-vwfh-vxw4: unauthenticated RCE in Image Optimization, plus a Windows-only RCE. The override stops `@react-email/preview-server` resolving its own vulnerable copy. |
| better-auth + @better-auth/sso 1.5.5 → 1.6.31 | OAuth refresh-token replay and SSO provider-registration SSRF, both patched in 1.6.11. Stayed on 1.6.x rather than upstream's 1.7.4 — `auth.ts` is fork-rewritten and carries a local-bypass plugin. |
| @better-auth/expo 1.5.5 → 1.6.31 | Peer range only. |
| linkify-it → 5.0.2 via overrides | Transitive; mirrors upstream 57e47b283. |
| **Removed** sanity (+ 6 satellites), braintrust, @posthog/ai, @portabletext/react | Unused here — no blog/marketing routes, no upstream eval harness, and LLM tracing that ships prompt metadata off-instance. Cleared basic-ftp, node-tar, fast-xml-parser, simple-git and protobufjs criticals. |

Result: 387 → 265 findings, 9 → 2 criticals. Both survivors are transitive through
`next-axiom` and `posthog-js`; stripping posthog (25 call sites) is its own job.

### Picked

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 711bb8343 | #2519 | Scope digest action lookup by email account | BACKPORT — cross-account read: any account could pass another's actionId and get its rule name. Source applied as-is; upstream's route.test.ts dropped (needs `createWithErrorTestMiddleware`, absent here) |
| 27cbae505 | #3237 | Encode Gmail batch message IDs | BACKPORT — hand-applied; fork's `getBatch` has no `queryString` param. Test keeps upstream's injection case, drops its batch-URL mock |
| e0bfddbd8 | #3249 | Validate API key account ownership | BACKPORT — a key could name an email account owned by another user. Test conflict resolved to the fork's inline-mock style; two new ownership cases added |
| 0545b139e | #3245 | Keep request secrets out of logs | BACKPORT — `req.url` (query string and all) was logged in six places; OAuth codes and api_key params landed in logs verbatim. `redact-fields.ts` hunks dropped; Slack `receivedState` now logged as a sha256 fingerprint |

### Evaluated and skipped

| Upstream | PR | Reason |
|---|---|---|
| 7db656cf7 | #3255 | Renames Redis `openai*` usage fields to provider-agnostic names. Cosmetic — the counters already aggregate every provider — and it ships a read-time migration against live Redis counters. Not worth a stateful migration on production for a naming change. |
| 653b2c6b9 | #3219 | Gemini rejects boolean constants in tool JSON Schema enums. The fork has no `clearAiInstructions`, and its ten `z.literal()` uses are all string discriminators, so the failure mode is unreachable. Worth re-checking if a boolean literal is ever added to a tool schema. |
| 613021689 | #3239 | SVG rejection in the image proxy; `packages/image-proxy` does not exist in this fork. |
| 5dbe9b079 | #3363 | Public-origin auth redirects. `auth-callback-deduplication.ts` is absent and the fork derives no redirect from `request.url`, so the proxy-origin bug does not reproduce here. |

### Deferred — real value, larger than one audit pass

| Upstream | PR | What it needs |
|---|---|---|
| d72b7d1fd | #2518 | Prevent duplicate pending digests. Six new files plus a unique-index migration — a Prisma migrate against production, so it wants its own change window. |
| ac124669c | #3075 | Cold email fails toward *not* blocking, and stops clobbering learned patterns. 8 of 14 files absent: the fork's Google webhook stack predates upstream's `process-history` split. |
| 633a2ab79 | #3341 | Keep the start and end of long emails when classifying thread status. `thread-status-context.ts` absent, but the `string.ts`/`mail.ts` truncation helpers would port on their own. |
| d41cb61f9 | #3156 | Avoid forwarding to existing message participants. Needs `executed-action-outcome.ts`, which the fork does not have. |

### Skipped wholesale (additions to the standing list)

- Mail UI redesign — 123 commits (#3204 → #3687) rebuilding the mail screen on
  upstream's new design system. The fork's mail screen has diverged; this is where
  merge pain would be worst and the payoff is cosmetic.
- Desktop/Electron shell (15 commits) — upstream ships a packaged Mac/Windows app.
- 702257825 — adds a "Sent with Inbox Zero" footer to composed mail. This fork is
  Inbox; upstream branding must never reach outgoing mail. Named here so no future
  audit picks it up by accident.

---

## Audit 2026-08-05

Range reviewed: `upstream-base` (59e496849, 2026-03-17) → `upstream-audit/2026-08-05`
(10b19ebea) — 1,025 commits.

### Picked

| Upstream | PR | Subject | Notes |
|---|---|---|---|
| 10038f89f | #2141 | Validate webhook URLs at rule save time (SSRF) | BACKPORT — helper wired into `mapActionFields` + copy/import paths |
| f68f3174f | #2758 | Anchor static from/to matching (anti-spoofing) | BACKPORT — hand-port; fork lacked upstream's match-rules refactor |
| 913cc0a57 | #2764 | Constant-time comparison for internal/cron secrets | BACKPORT — dropped booking/mobile-review files; payments stub untouched |
| c8b4992f7 | #2757 | Escape email fields against prompt injection | UPSTREAM — clean |
| c6877290a | #2916 | Token refresh 10-min buffer | BACKPORT — kept fork's Redis refresh lock; dropped provider-health infra |
| 89e5bc0e3 | #2980 | Notify when email watch lapses | BACKPORT — premium select inlined; error-messages adapted to fork layout |
| 91ac444b9 | #2992 | Opt-in DELETE rule action | BACKPORT — hand-port; additive enum migration copied verbatim; flag off by default |
| b74f571a9 | #2893 | `WEBHOOK_ALLOW_PRIVATE_IPS` opt-in | BACKPORT — gate ported into fork's `validateWebhookUrl`; webhook.ts hunk dropped |
| 7316b42dc | #2906 | Rules list A→Z sort + inline search | UPSTREAM — clean |
| a7c1423a3 | #3003 | Prevent chart CSS injection | BACKPORT — RuleStatsChart nameKey adapted |
| a7de7121b | #3097 | Handle provider rate limits reliably | BACKPORT — also gated redis feature on `REDIS_URL` (fork uses ioredis, not Upstash) |

### Evaluated and skipped

| Upstream | PR | Reason |
|---|---|---|
| 20612a614 | #2512 | Outlook page-token hardening; depends on unpicked #2509 infra. Instance is Gmail-only — attack surface unreachable. Revisit if an Outlook account is ever connected. |
| 0336344e8 | #2643 | LOGIN_PROVIDERS enforcement; the security property (only configured OAuth providers registered) already holds in the fork's rewritten `auth.ts`. Hunks land in fork-rewritten login files. |
| ec8f3e9c9 | #3099 | Bulk-work stop during Gmail throttling; fork's bulk-unsubscribe stack predates upstream's #2812 rework (400+ line divergence). UX-only value. Revisit if bulk operations hit rate limits in practice. |
| 3acc63c00 | #2790 | Role-based LLM config; 15 files collide with fork's custom LiteLLM/Ollama routing. Per-role routing is achievable at the LiteLLM gateway instead. |
| a8fe1f04d | #2788 | OpenAI-compatible eval config; fork does not run upstream's eval harness. |

### Skipped wholesale (feature categories never audited commit-by-commit)

- Billing/Stripe/analytics/PostHog — deliberately removed from this fork.
- Mobile app REST backend — serves upstream's closed-source store app; fork's
  remote access is the web UI + MCP server.
- AI meeting recorder (Recall.ai) — covered by external Neosapien/MeetEcho MCPs.
- Organizations/teams — single-user instance; revisit as its own project if needed.
- Marketing pages, changelog, sponsor badges.

---

## Fork-local divergences (not upstream fixes — do not let a backport revert these)

| Area | Files | Why the fork differs |
|---|---|---|
| Decision model (Jev) | `apps/web/utils/decision-model/*`, call sites in `cold-email/is-cold-email.ts`, `ai/reply/determine-thread-status.ts`, `ai/categorize-sender/*`, `ai/choose-rule/ai-detect-recurring-pattern.ts` | Upstream's decision-model is Jev-or-LLM on AI SDK 7. The fork calls the System One API directly (AI SDK 6), adds **shadow mode** (LLM decides, Jev recorded in `DecisionModelRun`; features go live one at a time via `DECISION_MODEL_LIVE`), and **escalates** uncertain answers to `DECISION_ESCALATION_MODEL` rather than the account's own model. Do NOT backport upstream's `isDecisionModelEnabledForUser` rule that skips users with their own `aiApiKey` — every user here has one (a LiteLLM key), so it would silently turn Jev off. Thread-status criteria are the fork's own, not upstream's #3787 definitions. |
| PostHog removed | `apps/web/utils/posthog.ts` (deleted), `apps/web/providers/PostHogProvider.tsx` (deleted), `apps/web/hooks/useFeatureFlags.ts`, `apps/web/hooks/useAnalytics.ts`, `apps/web/ee/billing/stripe/posthog-events.ts` (deleted) | Analytics are removed from this deployment, and `posthog-js` was the last path to a critical protobufjs advisory. Feature flags are env-only and the landing A/B experiments resolve to their control arms. Upstream keeps adding `posthog.capture` calls and `useFeatureFlagEnabled` gates — a backport touching onboarding, bulk-unsubscribe, pricing, rules or the assistant tools must drop those hunks rather than reintroduce the dependency. `useOnboardingAnalytics` survives as a no-op shape and `NEXT_PUBLIC_POSTHOG_ONBOARDING_SURVEY_ID` is kept deliberately (it identifies stored onboarding answers). |
| Gmail poller and the history pointer | `apps/web/app/api/process-emails/process-account.ts` | The webhook owns `lastSyncedHistoryId` and stops it before mail it could not process. The poller writes the pointer only when it is null and uses `withMessageProcessingLock`. Do not restore the unconditional `lastSyncedHistoryId: currentHistoryId` update. |
| Reserved-recipient guard | `packages/resend/src/reserved-recipients.ts`, `packages/resend/src/send.tsx` | Fork-local (GRI-492). The private `sendEmail` asserts the resolved recipient is not an RFC 2606 / `test.com` fixture address, so none of the seven exported senders can put live mail on a reserved domain. Upstream has no equivalent — do not let a backport touching `send.tsx` drop the assert or restore the inline `to: test ? ... : to` ternary. |
| Scheduled check-ins | `apps/web/utils/ai/automation-jobs/generate-check-in-message.ts`, `apps/web/utils/automation-jobs/message.ts`, `apps/web/utils/automation-jobs/messaging.ts`, `apps/web/utils/ai/assistant/chat.ts` (`readOnly`), `apps/web/utils/ai/assistant/get-recent-chat-memories.ts` | Upstream generates the check-in with `createGenerateObject` and a one-field `{ message }` schema, then silently falls back to `return trimmedPrompt` when generation throws. Against this fork's LiteLLM/Ollama gateway `responseFormat` is unsupported, so every run fails JSON parsing and Telegram receives the raw prompt instead of a digest. The fork runs the check-in through `aiProcessAssistantChat` in a new `readOnly` mode (read tools only, unattended) and lets failures fail the run instead of echoing the prompt. Upstream `main` (b3e10ebdb, 2026-09-06) still has the original code — re-check before backporting anything under `utils/automation-jobs/` or `utils/ai/automation-jobs/`. |
