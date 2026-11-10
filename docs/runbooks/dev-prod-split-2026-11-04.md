# Inbox: splitting dev and prod (NUC → Mac mini), 2026-11-04

## Why
Inbox was developed and run in production from the same checkout on the NUC. A `git pull`, a `pnpm install` or a migration
in that checkout could change production, and production used a hand-run compose file (`docker-compose.prod.yml`
plus `scripts/deploy-prod.sh`). Same move as TaskPilot's on 2026-10-27: development on the Mac mini, and production
as a Git-backed Portainer stack deployed from CI.

## What was done
1. **Production became stack `inbox-prod` (id 209)** on NAS Portainer, endpoint 11 (the NUC), Git-backed on
   `refs/heads/sudipta_main`, file `deploy/stack.yml`. The image is `ghcr.io/sudipta26889/inbox-web:${IMAGE_TAG:-latest}`.
2. **Deploy = push to `sudipta_main`.** `.github/workflows/deploy.yml` tests, builds the image, calls the stack
   webhook, and polls `/api/health` until it reports the short SHA. Pushes that only touch docs do not deploy.
3. **Rollback**: set `IMAGE_TAG=<short-sha>` in the stack Env and redeploy, or `git revert` and push. Clear the pin
   afterwards, or the next deploy's version poll fails.
4. **Database role**: production moved off the old superuser to its own owner role. The old role is NOLOGIN and owns
   nothing. Migrations run at container start under the new role; read the start log after any migration.
5. **Dev on the Mac**, directly (owner exception to Docker-only), with `apps/web/.env.local` only, its own database
   and Valkey user on `db.lan`. Dev users are refused on the production database by `pg_hba`.
6. **NUC checkout retired.** Git-ignored files, transcripts and a rescue bundle were copied to the Mac before the
   owner deletes the folder (after 2026-11-11 22:07Z, from a checklist). The old compose file, deploy script and `docker:prod:*` scripts were removed from the repo.

## The VM incident (2026-11-04)
A first attempt ran `next dev` and a production image build inside the shared OrbStack VM on the Mac, which also hosts
another production app. A cold `next dev` reached about 5 GB of the VM's 8 GB; the VM hit its limit, an OOM kill
followed, and the VM filesystem went read-only, taking the other app down with it.
- `next dev` runs on the Mac itself, only during active work. Never in the shared VM.
- Production images build in CI, never on a shared machine.
- Check what else shares a machine before heavy work. Watch VM memory, not just swap.

## Gotchas found along the way
- A fresh clone lacks `.git/info/exclude`, global ignore rules, tags, rerere and rr-cache. Copy them on purpose.
- No `.env` in `apps/web`: Next loads it automatically, so production keys would reach dev.
- Install with `HUSKY=0 pnpm install`, or husky replaces local git hooks.
- Portainer refuses to clone repos with symlinks.
- GitHub can switch off Actions on a fork without notice; merges then stop deploying silently. A merge is done only
  when `/api/health` reports its SHA.
- A green CI check can be empty: read the test counts.
- `docker ps` can be stale on a failing VM, and a 200 from the proxy is not health. Check logged-in pages and logs.
- Messages between agent sessions are not owner approval.
