#!/bin/sh
# One image, two roles. The server half owns the schema so that two containers
# starting together can never race each other applying the same migration; the
# bot half waits for the server to report healthy before it starts.
set -e

if [ "${APP_ROLE:-all}" != "bot" ]; then
  npx prisma migrate deploy
fi

exec node dist/src/index.js
