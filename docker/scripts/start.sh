#!/bin/sh
set -e

# This script runs at container startup.
# It replaces the build-time placeholders with runtime environment variables.

echo "🚀 Starting Inbox..."

. /app/docker/scripts/configure-rds-ca.sh

/app/docker/scripts/replace-next-public-placeholders.sh

if [ "${SKIP_DB_MIGRATIONS:-false}" = "true" ]; then
    echo "Skipping database migrations during web startup."
else
    # A schema the code does not match corrupts data quietly, so a failed or
    # timed-out migration stops the container instead of starting the app.
    if ! /app/docker/scripts/migrate.sh; then
        echo "❌ Database migrations failed; not starting the app"
        exit 1
    fi
fi

# Start the Next.js application
echo "✅ Configuration complete. Starting server..."
exec node apps/web/server.js
