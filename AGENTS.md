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
- Develop on the Mac mini (`/Volumes/Storage/Workspace/inbox`), never on the NUC. `.env` and `apps/web/.env` hold production values, so dev must never read them; dev uses `apps/web/.env.local`.
- Do not run `next dev` in the shared OrbStack VM. It also hosts another production app. A cold start reaches about 5 GB of the VM's 8 GB and is OOM-killed at a 5 GB limit; on 2026-11-04 one of those kills coincided with the VM filesystem going read-only. The stack is `docker compose --profile next-dev up -d` (http://dharabot.lan:5500, crons with `--profile cron` as well), and it stays off.
- The dev path is a local stack from the CI-built production image, using `.env.local`, never `.env`. Build it after the first image exists. It has no hot reload. Production image builds run in CI, not in this VM.
- Dev login is the bypass button on `/login` (`LOCAL_AUTH_BYPASS_ENABLED`, a separate test user, active only when `NODE_ENV=development`).
- Deploy = push to `sudipta_main` (not `main`, which stays as it is): `.github/workflows/deploy.yml` tests, builds `ghcr.io/sudipta26889/inbox-web`, and calls the Portainer webhook for stack `inbox-prod` (NAS Portainer, endpoint 11, on the NUC, `deploy/stack.yml`).
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
