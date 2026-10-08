# ChangeNOW Telegram Exchange

Некостодиальный сервис обмена криптовалют через ChangeNOW API.
Подробности и архитектура: [docs/PROJECT.md](docs/PROJECT.md).

**Текущий этап: инфраструктура и доменная модель данных.** Реализованы Node.js/TypeScript, Express
(`GET /health`), PostgreSQL, Prisma-модели и миграция (`User`, `Exchange`, `ExchangeStatusHistory`,
`NotificationOutbox`), матрица переходов статусов обмена, интерфейс `ExchangeProvider` и
`MockExchangeProvider`, `ExchangeService` с Prisma-репозиторием (compare-and-set переходы с историей,
идемпотентное создание, сверка статуса с провайдером), Zod-конфигурация, Pino, Vitest.
Telegram-бота, worker, outbox-sender, реального клиента ChangeNOW и кошельков пока нет;
сервис пока не подключён к `src/index.ts`.

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
| `npm test`                | Vitest (тесты БД — только при `TEST_DATABASE_URL`)    |
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
- Модели описаны в `prisma/schema.prisma`, миграция `domain_model` — в `prisma/migrations/`.
  Применение: `npx prisma migrate deploy`.
- Часть ограничений (CHECK, триггер неизменяемости `exchange_status_history`) лежит в ручном SQL-блоке
  миграции и не отражена в `schema.prisma`. Не используйте `prisma db pull` и не пересоздавайте миграции
  без переноса этого блока. Ограничения покрыты тестами `tests/db`.
- Интеграционные тесты БД: создайте отдельную базу `changenow_test` и задайте `TEST_DATABASE_URL`
  (см. `.env.example`). Без неё тесты `tests/db` пропускаются.

## Структура

```
src/
  application/     # сценарии: ExchangeService (единственное место смены статусов), порт репозитория
  config/          # Zod-конфигурация окружения
  database/        # Prisma client (generated/ — артефакт генерации), repositories/
  domain/          # чистая доменная логика: статусы обмена и переходы, порт ExchangeProvider,
                   # арифметика десятичных сумм (строки, без Float)
  integrations/    # адаптеры внешних провайдеров (пока только MockExchangeProvider в памяти)
  http/            # Express-приложение, /health, graceful shutdown
  observability/   # Pino-логгер с маскированием чувствительных полей
  index.ts         # точка входа
tests/             # Vitest (domain/, db/ — интеграционные тесты схемы)
prisma/            # schema.prisma и миграции
docs/              # документация проекта
```

## Версии

TypeScript зафиксирован на `~6.0`, так как `typescript-eslint` пока не поддерживает TypeScript 7.
Prisma — стабильная 7.x (тег `latest` у `prisma` CLI указывает на RC 8.x).
