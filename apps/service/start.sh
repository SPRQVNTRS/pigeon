#!/bin/sh
set -e
if [ "${RUN_MIGRATIONS:-false}" = "true" ]; then
  node --import tsx ./drizzle/migrate.ts
fi
exec node --import tsx ./server.ts
