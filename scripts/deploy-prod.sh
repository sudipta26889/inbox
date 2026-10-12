#!/usr/bin/env bash
# Build and redeploy production web, inside a GuardianAI maintenance window.
#
# Without the window GuardianAI sees the restart as an outage and runs its own
# `compose up` ~30 s later, recreating the container a second time (two 502
# windows per deploy).
#
# Usage: scripts/deploy-prod.sh [rollback-tag]
set -euo pipefail

cd "$(dirname "$0")/.."
GUARDIAN_URL="${GUARDIAN_URL:-http://localhost:8890}"
# Read from GuardianAI's own env so the secret is never copied into this repo.
GUARDIAN_API_TOKEN="${GUARDIAN_API_TOKEN:-$(grep -m1 '^GUARDIAN_API_TOKEN=' /mnt/projects/GuardianAI/.env 2>/dev/null | cut -d= -f2- | tr -d '"')}"
GUARDIAN_AUTH=(-H "Authorization: Bearer $GUARDIAN_API_TOKEN")
COMPOSE=(docker compose -f docker-compose.prod.yml)

curl -fsS -X POST "$GUARDIAN_URL/api/v2/apps/inbox/maintenance" "${GUARDIAN_AUTH[@]}" \
  -H "Content-Type: application/json" -d '{"minutes": 20}' >/dev/null \
  || echo "warning: could not open a GuardianAI maintenance window" >&2
# ponytail: window clears itself after 20 min if this script dies midway.
trap 'curl -fsS -X DELETE "$GUARDIAN_URL/api/v2/apps/inbox/maintenance" "${GUARDIAN_AUTH[@]}" >/dev/null || true' EXIT

if [[ -n "${1:-}" ]]; then
  docker tag inbox-prod:latest "inbox-prod:$1"
fi

"${COMPOSE[@]}" build web
"${COMPOSE[@]}" up -d --no-build web

for _ in $(seq 1 60); do
  [[ "$(curl -s -o /dev/null -w '%{http_code}' https://inbox.sudiptadhara.in/)" == 200 ]] && break
  sleep 5
done
code="$(curl -s -o /dev/null -w '%{http_code}' https://inbox.sudiptadhara.in/)"
echo "https://inbox.sudiptadhara.in/ -> $code"
"${COMPOSE[@]}" logs --tail 40 web | grep -E "pending|migrations" || true
[[ "$code" == 200 ]]
