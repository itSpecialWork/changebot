# ChangeNOW Telegram Exchange

Некостодиальный сервис обмена криптовалют через ChangeNOW API.
Подробности и архитектура: [docs/PROJECT.md](docs/PROJECT.md).

**Текущий этап: инфраструктурная основа.** Реализованы только Node.js/TypeScript, Express (`GET /health`),
PostgreSQL, Prisma (без моделей), Zod-конфигурация, Pino, Vitest. Telegram-бота, ChangeNOW, обменов,
кошельков и бизнес-логики пока нет.

## Требования

- Node.js >= 22.18 (LTS, см. `.nvmrc`)
- npm >= 10
- Docker и Docker Compose v2

## Быстрый старт

```bash
npm install
cp .env.example .env          # затем замените CHANGE_ME на свой пароль (в POSTGRES_PASSWORD и DATABASE_URL)
npm run db:up                 # PostgreSQL в Docker (ждёт healthcheck)
npm run prisma:validate
npm run prisma:generate
npm run dev                   # http://127.0.0.1:3000/health
```

Проверка:

```bash
curl -i http://127.0.0.1:3000/health
```

## Скрипты

| Скрипт                    | Назначение                                            |
| ------------------------- | ----------------------------------------------------- |
| `npm run dev`             | запуск с автоперезагрузкой (`tsx watch`)              |
| `npm run build`           | генерация Prisma Client и сборка TypeScript в `dist/` |
| `npm start`               | запуск собранного приложения (`node dist/index.js`)   |
| `npm run lint`            | ESLint (strict type-checked)                          |
| `npm run typecheck`       | генерация Prisma Client и `tsc --noEmit`              |
| `npm test`                | Vitest (без обращения к сети и БД)                    |
| `npm run format`          | Prettier (запись)                                     |
| `npm run format:check`    | Prettier (только проверка)                            |
| `npm run prisma:validate` | валидация `prisma/schema.prisma`                      |
| `npm run db:up / db:down` | запуск / остановка PostgreSQL (данные сохраняются)    |

## Конфигурация

Все переменные описаны в `.env.example` и проверяются через Zod при старте (`src/config/env.ts`).
При ошибке приложение завершается с понятным сообщением, не раскрывая значения переменных.

`POSTGRES_*` используются `docker-compose.yml`, `DATABASE_URL` — приложением и Prisma.
Значения должны быть согласованы между собой. Файл `.env` в git не коммитится.

## База данных

- PostgreSQL 18 в Docker, порт опубликован только на `127.0.0.1`.
- Данные хранятся в именованном volume `postgres_data`.
  Полное удаление данных: `docker compose down -v` (необратимо).
- Prisma 7 использует driver adapter `@prisma/adapter-pg`; клиент генерируется в `src/database/generated`
  (в git не хранится, создаётся командами `build` и `typecheck` либо `npm run prisma:generate`).
- Модели и миграции пока не созданы.

## Структура

```
src/
  config/          # Zod-конфигурация окружения
  database/        # Prisma client (generated/ — артефакт генерации)
  http/            # Express-приложение, /health, graceful shutdown
  observability/   # Pino-логгер с маскированием чувствительных полей
  index.ts         # точка входа
tests/             # Vitest
prisma/            # schema.prisma (без моделей)
docs/              # документация проекта
```

## Версии

TypeScript зафиксирован на `~6.0`, так как `typescript-eslint` пока не поддерживает TypeScript 7.
Prisma — стабильная 7.x (тег `latest` у `prisma` CLI указывает на RC 8.x).
