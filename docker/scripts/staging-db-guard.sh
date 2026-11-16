#!/bin/sh
# Staging must only ever run against a restored refork clone (inbox_refork_*).
# With an Env pasted from production, start.sh would apply migrations to the
# production database. Prints database names only, never a URL.

[ "${DHARAHIL_ENVIRONMENT:-}" = "staging" ] || exit 0

# Same precedence as docker/scripts/prisma.config.ts, plus the app's own URL.
migration_url="${PREVIEW_DATABASE_URL_UNPOOLED:-${PREVIEW_DATABASE_URL:-${DIRECT_URL:-${DATABASE_URL:-}}}}"

check() {
    name="$1"
    url="$2"
    path="${url%%\?*}"
    db="${path##*/}"
    case "$db" in
        inbox_refork_*) return 0 ;;
    esac
    if [ -z "$url" ]; then
        echo "❌ Staging: $name is not set; refusing to start" >&2
    else
        echo "❌ Staging: $name does not name an inbox_refork_* database; refusing to start" >&2
    fi
    exit 1
}

check "the migration database URL" "$migration_url"
check "DATABASE_URL" "${DATABASE_URL:-}"
