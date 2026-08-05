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
- Repo config: `rerere.enabled` + `merge.conflictStyle=zdiff3` are set, so
  recurring conflicts resolve themselves on the second occurrence.

Next audit: `git fetch upstream && git log --oneline -i -E --grep='security|CVE|vuln|xss|csrf|ssrf|injection|sanitiz|auth' upstream-audit/<last>..upstream/main`
Also check the upstream repo's GitHub Security tab, and run `pnpm audit` —
for this stack most real CVEs are in dependencies, not app code.

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
