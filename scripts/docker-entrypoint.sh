#!/bin/sh
# Миграции и один процесс обмена. Второй экземпляр с тем же токеном не запускать.
set -eu

cd /app
npx prisma migrate deploy
exec node dist/index.js
