#!/usr/bin/env bash
# Ночной дамп серверной базы. Ноутбучную базу этот скрипт не трогает и на сервер не заливает.
# Учебное восстановление: ./scripts/backup-db.sh --drill
# Оно пишет во временную базу changenow_restore и затем удаляет её.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BACKUP_DIR="${BACKUP_DIR:-/var/backups/changenow}"
KEEP="${BACKUP_KEEP:-7}"
DRILL_DB="changenow_restore"
COMPOSE=(docker compose --project-directory "$ROOT" -f "$ROOT/docker-compose.prod.yml")

drill=0
if [[ "${1:-}" == "--drill" ]]; then
  drill=1
elif [[ -n "${1:-}" ]]; then
  echo "Неизвестный аргумент. Без аргументов — дамп. --drill — дамп и проверка восстановления." >&2
  exit 1
fi

env_value() {
  local key="$1"
  local raw=""
  if [[ -f .env ]]; then
    raw="$(grep -E "^${key}=" .env | tail -n 1 || true)"
  fi
  raw="${raw#"${key}="}"
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "$raw"
}

POSTGRES_USER="$(env_value POSTGRES_USER)"
POSTGRES_DB="$(env_value POSTGRES_DB)"
BACKUP_TARGET="$(env_value BACKUP_TARGET)"

if [[ -z "$POSTGRES_USER" || -z "$POSTGRES_DB" ]]; then
  echo "В .env нужны POSTGRES_USER и POSTGRES_DB." >&2
  exit 1
fi

if [[ "$POSTGRES_DB" == "$DRILL_DB" ]]; then
  echo "POSTGRES_DB не должен называться ${DRILL_DB}." >&2
  exit 1
fi

if [[ ! -d "$BACKUP_DIR" ]]; then
  mkdir -p "$BACKUP_DIR"
fi
if [[ ! -w "$BACKUP_DIR" ]]; then
  echo "Нет права записи в ${BACKUP_DIR}. Создайте каталог и отдайте его пользователю deploy." >&2
  exit 1
fi
chmod 700 "$BACKUP_DIR" || true

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
dump_file="${BACKUP_DIR}/changenow-${stamp}.dump"

if ! "${COMPOSE[@]}" exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$dump_file"; then
  rm -f "$dump_file"
  exit 1
fi
chmod 600 "$dump_file"

mapfile -t dumps < <(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'changenow-*.dump' -printf '%T@ %p\n' | sort -nr | cut -d' ' -f2-)
if ((${#dumps[@]} > KEEP)); then
  rm -- "${dumps[@]:KEEP}"
fi

if [[ -n "$BACKUP_TARGET" ]]; then
  remote_name="$(basename "$dump_file")"
  if [[ "$BACKUP_TARGET" == s3://* ]]; then
    if ! command -v aws >/dev/null 2>&1; then
      echo "Локальный дамп сохранён. Для S3 на сервере нужна команда aws." >&2
      exit 1
    fi
    aws s3 cp "$dump_file" "${BACKUP_TARGET%/}/${remote_name}"
  else
    scp -o BatchMode=yes "$dump_file" "${BACKUP_TARGET%/}/"
  fi
fi

if [[ "$drill" -ne 1 ]]; then
  exit 0
fi

drop_drill() {
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${DRILL_DB}' AND pid <> pg_backend_pid();" \
    >/dev/null || true
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS ${DRILL_DB};" >/dev/null || true
}

trap drop_drill EXIT

drop_drill
"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE ${DRILL_DB};" >/dev/null
"${COMPOSE[@]}" exec -T postgres pg_restore -U "$POSTGRES_USER" -d "$DRILL_DB" --no-owner --exit-on-error <"$dump_file"

applied="$(
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$DRILL_DB" -At -v ON_ERROR_STOP=1 \
    -c "SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL ORDER BY migration_name;"
)"
expected="$(find prisma/migrations -mindepth 1 -maxdepth 1 -type d -printf '%f\n' | sort)"
applied="$(printf '%s\n' "$applied" | sed '/^$/d' | sort)"

if [[ "$applied" != "$expected" ]]; then
  echo "Миграции во временной базе не совпали с prisma/migrations. Рабочая база не изменялась." >&2
  printf '%s\n' "$applied" >&2
  exit 1
fi

echo "Восстановление во временную базу совпало с миграциями репозитория. Временная база будет удалена."
