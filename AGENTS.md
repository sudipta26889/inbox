# Repository Guidelines

## Build & Test Commands
- Development: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint`
- Format: Biome (`pnpm check` / `pnpm fix` via ultracite)
- Run all tests: `pnpm test`
- Run AI tests: `pnpm test-ai`
- Run single test: `pnpm test __tests__/test-file.test.ts`
- Run specific AI test: `pnpm test-ai ai-categorize-senders`
- Type-check build (skips Prisma migrate): `pnpm --filter inbox-ai exec next build`
- Do not run `dev` or `build` unless explicitly asked
- Run `pnpm install` before running tests or build if not already done
- Before writing or updating tests, review `.claude/skills/testing/SKILL.md`.
- When adding a new workspace package, add its `package.json` COPY line to `docker/Dockerfile.prod` and `docker/Dockerfile.local`.

## Dev and deploy
- Develop on the Mac mini (`/Volumes/Storage/Workspace/inbox`), never on the NUC. Dev uses only `apps/web/.env.local`; production values live in the Portainer stack.
- Dev runs directly on the Mac, by owner exception to the Docker-only rule, and only during active work: `cd apps/web && PATH=/opt/homebrew/opt/node@24/bin:$PATH NODE_OPTIONS=--max-old-space-size=3072 INTERNAL_API_URL=http://localhost:5500 pnpm exec next dev --turbopack --port 5500 --hostname 0.0.0.0`, served at http://dharabot.lan:5500 with `.env.local` and the dev database and Valkey user on `db.lan`. Keep no `.env` in `apps/web`: Next loads it automatically and production keys would reach dev. Install with `HUSKY=0 pnpm install` so husky does not replace local git hooks. Run migrations against dev with the values from `.env.local`.
- Do not run `next dev` in the shared OrbStack VM, which also hosts another production app: a cold start reaches about 5 GB of its 8 GB, and on 2026-11-04 an OOM kill at that limit coincided with the VM filesystem going read-only. Production image builds run in CI, not in this VM.
- Dev login is the bypass button on `/login` (`LOCAL_AUTH_BYPASS_ENABLED`, a separate test user, active only when `NODE_ENV=development`).
- Deploy = push to `sudipta_main` (not `main`, which stays as it is): `.github/workflows/deploy.yml` tests, builds `ghcr.io/sudipta26889/inbox-web`, and calls the Portainer webhook for stack `inbox-prod` (NAS Portainer, endpoint 11, on the NUC, `deploy/stack.yml`).
- Production is Git-backed stack `inbox-prod`, id 209, on NAS Portainer endpoint 11, ref `refs/heads/sudipta_main`. Every non-docs push to `sudipta_main` deploys to production. Rollback: set `IMAGE_TAG=<sha>` in the stack 209 Env (the stack image is `inbox-web:${IMAGE_TAG:-latest}`) and redeploy, or `git revert` and push. While a pin is set, `deploy.yml`'s version poll fails on new pushes, so clear `IMAGE_TAG` afterwards.
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
- Only add comments for "why", not "what". Prefer self-documenting code.
- Logging: avoid duplicating logger context fields from higher in the call chain. Use `logger.trace()` for PII fields (from, to, subject, etc.).
- Tests should use the real logger implementation (do not mock `@/utils/logger`).
- Avoid low-value tests that mostly restate implementation details; prefer tests that catch a real behavioral regression.
- Helper functions go at the bottom of files, not the top
- All imports at the top of files, no mid-file dynamic imports
- Co-locate test files next to source files (e.g., `utils/example.test.ts`). Only E2E and AI tests go in `__tests__/`.
- Don't export types/interfaces only used within the same file
- No re-export patterns. Import from the original source.
- Prefer the `EmailProvider` abstraction; only use provider-type checks (`isGoogleProvider`, `isMicrosoftProvider`) at true provider boundary/integration code.
- Infer types from Zod schemas using `z.infer<typeof schema>` instead of duplicating as separate interfaces
- Avoid premature abstraction. Duplicating 2-3 times is fine; extract when a stable pattern emerges.
- No barrel files. Import directly from source files.
- Colocate page components next to their `page.tsx`. No nested `components/` subfolders in route directories.
- Reusable components shared across pages go in `apps/web/components/`
- One resource per API route file
- Env vars: add to `.env.example`, `env.ts`, and `turbo.json`. Prefix client-side with `NEXT_PUBLIC_`.
- Never use dynamic Prisma transactions (`prisma.$transaction(async (tx) => ...)`).

## Change Philosophy
- Prefer the simplest, most readable change; only keep backwards compatibility when explicitly requested.
- Do not optimize for migration paths: refactor call sites directly, including larger coordinated changes when clarity improves.

## Component Guidelines
- Use shadcn/ui components when available
- Use `LoadingContent` component for async data: `<LoadingContent loading={isLoading} error={error}>{data && <YourComponent data={data} />}</LoadingContent>`

## Fullstack Workflow
See `.claude/skills/fullstack-workflow/SKILL.md` for full examples and templates.

- API route middleware: `withError` (public, no auth), `withAuth` (user-level), `withEmailAccount` (email-account-level). Export response type via `Awaited<ReturnType<typeof getData>>`.
- Mutations: use server actions with `next-safe-action`, NOT POST API routes.
- Validation: Zod schemas in `utils/actions/*.validation.ts`. Infer types with `z.infer`.
- Data fetching: SWR on the client. Call `mutate()` after mutations.
- Forms: React Hook Form + `useAction` hook. Use `getActionErrorMessage(error.error)` for errors.
- Loading states: use `LoadingContent` component.
