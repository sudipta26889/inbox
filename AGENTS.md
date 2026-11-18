# Repository Guidelines

## Build & Test Commands
- Development: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint`
- Format: Biome (`pnpm check` / `pnpm fix` via ultracite)
- Run all tests: `pnpm test`
- Run integration tests: `pnpm test-integration`
- Run AI tests: `pnpm --filter inbox-zero-ai test-ai`
- Run single test: `pnpm test path/to/test-file.test.ts`
- Run focused browser test: `pnpm -F inbox-zero-ai test:playwright:emulated <area-or-spec>`; for browser-facing UI changes, inspect the generated screenshots before finishing
- Moving, renaming, or hiding a UI affordance breaks specs that select it by visible name. Grep `__tests__/playwright` for that name before pushing, and never pipe the grep through `head` — a truncated result read as complete misses call sites. Screenshots will not catch this; the UI still looks right.
- Waiting on slow work (CI, a Playwright run, a build): background one command that exits when the work is actually done. The harness notifies you when it exits, so a polling loop on top of it only duplicates that signal.
- Bound anything that can hang so it always exits and reports rather than waiting forever. `timeout(1)` is not on macOS; use the Bash tool's own `timeout` parameter, or `perl -e 'alarm shift; exec @ARGV' <seconds> <command>`. If you must match on log output, anchor the pattern to the real summary line (`^\s+[0-9]+ (passed|failed)`), not a bare `failed` that startup banners also contain.
- Run specific AI/eval test: `pnpm --filter inbox-zero-ai test-ai __tests__/eval/your-test.test.ts`
- Evals in `apps/web/__tests__/eval/` must be run from repo root with `pnpm --filter inbox-zero-ai test-ai` (not `pnpm test`)
- Type-check build (skips Prisma migrate): `pnpm --filter inbox-zero-ai exec next build`
- Do not use root `tsc --noEmit`; it is not a supported validation step in this monorepo and surfaces unrelated repo-wide debt. If you need the app's CI-aligned type/build check, use `pnpm --filter inbox-zero-ai build:ci` instead, and only when explicitly asked.
- Do not run `dev` or `build` unless explicitly asked
- Run `pnpm install` before running tests or build if not already done
- Before writing or updating tests, review `.claude/skills/testing/SKILL.md`.
- For core bug-fix tasks, default to TDD when practical (red/green/refactor); AI prompt improvements should generally be backed by evals too, and TDD is often useful there as well.
- When adding a new workspace package, add its `package.json` COPY line to `docker/Dockerfile.prod` and `docker/Dockerfile.local`.

## Dev and deploy
- Develop on the Mac mini (`/Volumes/Storage/Workspace/inbox`), never on the NUC. Dev uses only `apps/web/.env.local`; production values live in the Portainer stack.
- Dev runs directly on the Mac, by owner exception to the Docker-only rule, and only during active work: `cd apps/web && PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=3072 INTERNAL_API_URL=http://localhost:5500 pnpm exec next dev --turbopack --port 5500 --hostname 0.0.0.0`, served at http://dharabot.lan:5500 with `.env.local` and the dev database and Valkey user on `db.lan`. Keep no `.env` in `apps/web`: Next loads it automatically and production keys would reach dev. Install with `HUSKY=0 pnpm install` so husky does not replace local git hooks. Run migrations against dev with the values from `.env.local`.
- Do not run `next dev` in the shared OrbStack VM, which also hosts another production app: a cold start reaches about 5 GB of its 8 GB, and on 2026-11-04 an OOM kill at that limit coincided with the VM filesystem going read-only. Production image builds run in CI, not in this VM.
- Dev login is the bypass button on `/login` (`LOCAL_AUTH_BYPASS_ENABLED`, a separate test user, active only when `NODE_ENV=development`).
- Since the re-fork (2026-11-17) `next dev --turbopack` cannot resolve the pnpm global store. For a LAN preview use `next build --webpack` then `next start -p 5501` with `LOCAL_PREVIEW` (bypass also needs a DB named `inbox_refork_*` and a LAN/localhost base URL). Stop it when done: anyone on the LAN is signed in.
- Rollback after a migration is a database restore, not an image pin (the pre-re-fork image fails on the new schema).
- Deploy = push to `sudipta_main` (not `main`, which stays as it is): `.github/workflows/deploy.yml` tests, builds `ghcr.io/sudipta26889/inbox-web`, and calls the Portainer webhook for stack `inbox-prod` (NAS Portainer, endpoint 11, on the NUC, `deploy/stack.yml`).
- Production is Git-backed stack `inbox-prod`, id 209, on NAS Portainer endpoint 11, ref `refs/heads/sudipta_main`. Every non-docs push to `sudipta_main` deploys to production. Rollback: set `IMAGE_TAG=<sha>` in the stack 209 Env (the stack image is `inbox-web:${IMAGE_TAG:-latest}`) and redeploy, or `git revert` and push. While a pin is set, `deploy.yml`'s version poll fails on new pushes, so clear `IMAGE_TAG` afterwards.
- A merge is done only when `https://inbox.sudiptadhara.in/api/health` reports its short SHA. GitHub can switch off Actions on this fork without notice (it did on 2026-11-08), and then merges silently stop deploying: re-enable from the banner on the repository's Actions page. Only `deploy.yml`, `test.yml`, `build-check.yml` and `local-bypass-smoke.yml` stay enabled; the other inherited upstream workflows are disabled on purpose, because the ones on schedules waste compute here. GuardianAI alerts when production lags `sudipta_main`.
- New env key: also add it to `deploy/stack.yml` as `${KEY:-}` and to the stack Env. New `NEXT_PUBLIC_*`: add it as a build arg in `deploy.yml` and an `ARG`/`ENV` in `docker/Dockerfile.prod`.
- No symlinks in the repo: Portainer refuses to clone them.
- One homelab, one database server: every database, including dev, lives on `db.lan` (PostgreSQL, MariaDB, Valkey, Qdrant, Neo4j, RabbitMQ; see http://db.lan). Dev gets its own database and user there. Never add a local database container.

## MCP
To add this system in claude code user need to use `claude mcp add --transport http EmailCalendar https://inbox.sudiptadhara.in/mcp-server --scope user`

## Code Style
- Install packages in `apps/web`, not root: `cd apps/web && pnpm add ...`
- Lodash: import specific functions (`import groupBy from "lodash/groupBy"`)
- TypeScript with strict null checks
- Path aliases: `@/` for imports from project root
- NextJS app router with (app) directory, tailwindcss
- For version-sensitive or unclear Next.js behavior, check the relevant doc in `node_modules/next/dist/docs/` before changing framework code.
- Only add comments for "why", not "what". Prefer self-documenting code.
- Logging: avoid duplicating logger context fields from higher in the call chain. Use `logger.trace()` for PII fields (from, to, subject, etc.). Exception: the authenticated user's own email is fine to log at any level.
- Tests should use the real logger implementation (do not mock `@/utils/logger`).
- Avoid low-value tests that mostly restate implementation details; prefer tests that catch a real behavioral regression.
- Helper functions go at the bottom of files, not the top
- All imports at the top of files, no mid-file dynamic imports
- Avoid `useEffect` for mirroring fetched props/data into local state; prefer derived values or explicit edit state.
- Co-locate unit tests next to source files (e.g., `utils/example.test.ts`). Integration, E2E, and AI tests go in `__tests__/`.
- Don't export types/interfaces only used within the same file
- No re-export patterns. Import from the original source.
- Prefer the `EmailProvider` abstraction; only use provider-type checks (`isGoogleProvider`, `isMicrosoftProvider`) at true provider boundary/integration code.
- Infer types from Zod schemas using `z.infer<typeof schema>` instead of duplicating as separate interfaces
- Default to inlining and co-locating logic at the call site.
- Avoid premature abstraction. Small duplicated expressions are usually fine; extracting them often adds indirection without meaning.
- Do not duplicate substantial logic or correctness-sensitive rules. If copied code must stay in sync to avoid bugs, extract or centralize it early.
- Extract helpers when they make surrounding code clearer, name a meaningful domain concept, or keep shared behavior consistent across flows.
- Don't extract helpers that just rename and forward parameters; that's a layer without meaning.
- Avoid large/nested ternaries. Prefer straightforward control flow, a small helper, or a lookup table when it improves readability.
- No barrel files. Import directly from source files.
- Colocate page components next to their `page.tsx`. No nested `components/` subfolders in route directories.
- Reusable components shared across pages go in `apps/web/components/`
- One resource per API route file
- Env vars: add to `.env.example`, `env.ts`, and `turbo.json`. Prefix client-side with `NEXT_PUBLIC_`.
- Never use dynamic Prisma transactions (`prisma.$transaction(async (tx) => ...)`).

## Change Philosophy
- Respect module boundaries: keep feature-specific logic in its owning feature and shared infrastructure generic.
- Prefer the simplest, most readable change; only keep backwards compatibility when explicitly requested.
- Do not optimize for migration paths: refactor call sites directly, including larger coordinated changes when clarity improves.
- This is a public repository. Never include non-public data or internal details from private repositories or services in repository content or GitHub metadata; describe related private work only generically (for example, “updated the marketing repository”).

## LLM Features
- Stay AI-first: fix general failure modes, not exact eval wording, and avoid brittle keyword or regex rules unless the product needs a hard guard.
- Do not add keyword/phrase blacklists to prompts, evals, or tests just to catch a model's current bad wording. This product works across languages, so English-specific text checks are especially brittle. For LLM behavior, assert the semantic failure mode with a judge/eval criterion or structured contract instead. Example: test "does not ask unnecessary clarification or invent payment status," not "does not contain 'could you clarify' or 'specific payment'."
- Never gate context injection or tool behavior on ad hoc user-text keyword matching; use structured state, metadata, or explicit events instead.
- Tool descriptions should be self-contained: what the tool does, what its parameters mean, when to use it vs alternatives, prerequisites, and safety constraints specific to that tool.
- Keep only cross-cutting policies (identity, write confirmation, security, formatting) in the system prompt. Per-tool guidance belongs in the tool description so it appears only when the tool is active.
- Treat prompts, tools, and parameters as costly model-facing surface area. Every line must earn its place; do not add a tool or parameter for an edge case, and get explicit user approval before adding either.
- Do not duplicate guidance between prompts and tool descriptions. Explicitly disclose any prompt, tool, or tool-parameter change to the user.
- Keep model-facing schemas portable: prefer flat root objects and verify advanced constructs across providers. Use `z.strictObject()` only when dropping unknown keys is unsafe; describe refinement and transform constraints in tool fields because models may not see them.

## Component Guidelines
- Use shadcn/ui components when available
- Use `LoadingContent` component for async data: `<LoadingContent loading={isLoading} error={error}>{data && <YourComponent data={data} />}</LoadingContent>`
- UI translation uses Lingui; see `.claude/skills/i18n/SKILL.md`. A PR that adds or changes UI strings in a translated area wraps them and adds their translations to every locale's `messages.po` (`pnpm -F inbox-zero-ai intl:extract`).

## Fullstack Workflow
See `.claude/skills/fullstack-workflow/SKILL.md` for full examples and templates.

- API route middleware: `withError` (public, no auth), `withAuth` (user-level), `withEmailAccount` (email-account-level). Export response type via `Awaited<ReturnType<typeof getData>>`.
- Mutations: use server actions with `next-safe-action`, NOT POST API routes.
- Exception: mobile-native integrations may use POST API routes when they require a stable HTTP contract.
- Validation: Zod schemas in `utils/actions/*.validation.ts`. Infer types with `z.infer`.
- Data fetching: SWR on the client. Call `mutate()` after mutations.
- Forms: React Hook Form + `useAction` hook. Use `getActionErrorMessage(error.error)` for errors.
- Loading states: use `LoadingContent` component.
- Cursor Cloud VM setup: see `.claude/skills/cloud-dev-environment/SKILL.md`.
- Opening a PR: `.claude/skills/create-pr/SKILL.md`. Watching one to green (CI, review bots, comments): `.claude/skills/pr-watch/SKILL.md`. Do not hand-roll `gh api` polling; `pr-digest --watch` already blocks until checks settle and gives up at `PR_DIGEST_DEADLINE` (3600s) with a `WAIT_LIMIT` line rather than hanging.
