#!/bin/sh
# One image, two roles. The server half owns the database and the schema, so
# it alone applies migrations; the bot half has no database connection at all
# and waits for the server to report healthy before it starts.
set -e

if [ "${APP_ROLE:-all}" != "bot" ]; then
  npx prisma migrate deploy
fi

exec node dist/src/index.js
