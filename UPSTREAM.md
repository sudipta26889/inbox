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
- Branches: `main` is a **read-only mirror** of upstream at `upstream-base` — never
  commit or open PRs against it. All fork work goes on `sudipta_main`, which is the
  deployed branch. A PR merged to `main` does not reach production.
- Repo config: `rerere.enabled` + `merge.conflictStyle=zdiff3` are set, so
  recurring conflicts resolve themselves on the second occurrence.

Next audit: `git fetch upstream && git log --oneline -i -E --grep='security|CVE|vuln|xss|csrf|ssrf|injection|sanitiz|auth' upstream-audit/<last>..upstream/main`
Also check the upstream repo's GitHub Security tab, and run `pnpm audit` —
for this stack most real CVEs are in dependencies, not app code.

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
| Reserved-recipient guard | `packages/resend/src/reserved-recipients.ts`, `packages/resend/src/send.tsx` | Fork-local (GRI-492). The private `sendEmail` asserts the resolved recipient is not an RFC 2606 / `test.com` fixture address, so none of the seven exported senders can put live mail on a reserved domain. Upstream has no equivalent — do not let a backport touching `send.tsx` drop the assert or restore the inline `to: test ? ... : to` ternary. |
| Scheduled check-ins | `apps/web/utils/ai/automation-jobs/generate-check-in-message.ts`, `apps/web/utils/automation-jobs/message.ts`, `apps/web/utils/automation-jobs/messaging.ts`, `apps/web/utils/ai/assistant/chat.ts` (`readOnly`), `apps/web/utils/ai/assistant/get-recent-chat-memories.ts` | Upstream generates the check-in with `createGenerateObject` and a one-field `{ message }` schema, then silently falls back to `return trimmedPrompt` when generation throws. Against this fork's LiteLLM/Ollama gateway `responseFormat` is unsupported, so every run fails JSON parsing and Telegram receives the raw prompt instead of a digest. The fork runs the check-in through `aiProcessAssistantChat` in a new `readOnly` mode (read tools only, unattended) and lets failures fail the run instead of echoing the prompt. Upstream `main` (b3e10ebdb, 2026-09-06) still has the original code — re-check before backporting anything under `utils/automation-jobs/` or `utils/ai/automation-jobs/`. |
