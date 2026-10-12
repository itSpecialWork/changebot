# ChangeNOW Telegram Exchange

Некостодиальный сервис обмена криптовалют через ChangeNOW API.
Подробности и архитектура: [docs/PROJECT.md](docs/PROJECT.md).

**Текущий этап: Telegram-бот обмена и перевода.** По умолчанию провайдер — мок в памяти.
Живой ChangeNOW API v2 включается флагом `CHANGENOW_ENABLED=true` и требует `CHANGENOW_API_KEY`:
без ключа процесс не стартует и на мок не откатывается. Private Transfer (та же монета и та же сеть)
включается отдельно флагом `PRIVATE_TRANSFER_ENABLED`; ключ тот же. Другая сеть остаётся обычным
обменом. Оба флага по умолчанию выключены, пустое значение тоже выключено. Подробности — в `.env.example`.

Уже есть Express (`GET /health`), PostgreSQL, Prisma (`User`, `Exchange`, `ExchangeStatusHistory`,
`NotificationOutbox`), матрица статусов, `ExchangeService` (compare-and-set, идемпотентное создание,
сверка с провайдером), polling worker (lease через `FOR UPDATE SKIP LOCKED`) и outbox уведомлений
с retry, rate limiting и обработкой блокировки бота. Кошельки и Telegram Mini App в этот этап не входят.
Webhook статусов нет. Обмен, зависший в `CREATING` без id провайдера, worker сам не поднимает.

**Telegram-бот.** grammY, long polling. Меню, мастер «новый обмен»: валюты с подсказками «/»,
тип курса, сумма, адрес, memo, подтверждение. Та же монета и сеть пропускают тип курса: пользователь
указывает сумму получения или сумму, которая у него есть. Карточки обменов, отмена, уведомления
через outbox. Кнопка «⏩ Демо: следующий статус» есть только у тестового провайдера.
Адаптер `NotificationSender` на grammY переводит ошибки Telegram (403 / 429 / 400) в
`NotificationSendError`. Весь Telegram-код живёт в `src/telegram/`. Сервисы и worker'ы подключены
в `src/compose.ts`.

### Запуск бота

1. Получите токен у [@BotFather](https://t.me/BotFather) и добавьте в `.env`
   (файл в git не попадает): `TELEGRAM_BOT_TOKEN=<id>:<секрет>`.
2. `npm run db:up && npx prisma migrate deploy && npm run dev`.
3. Откройте бота в Telegram и отправьте `/start`.

Без `TELEGRAM_BOT_TOKEN` запускается только HTTP-сервер. Состояние мок-провайдера живёт в памяти:
после перезапуска старые тестовые обмены остаются в БД, но провайдер их уже «не помнит»
(опрос статуса будет откладываться с backoff). При включённом ChangeNOW статус хранит провайдер,
перезапуск процесса его не стирает.

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
npm run dev                   # http://127.0.0.1:3000/health (бот — при заданном TELEGRAM_BOT_TOKEN)
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
  telegram/        # весь Telegram: bot/ (интерфейс grammY) и notifications/ (отправка из outbox)
  integrations/    # мок в памяти и адаптер ChangeNOW API v2 (обмен и Private Transfer)
  compose.ts       # composition root: сервисы, worker'ы и бот
  http/            # Express-приложение, /health, graceful shutdown
  workers/         # фоновые циклы (ExchangeStatusWorker): только расписание, логика в application
  observability/   # Pino-логгер с маскированием чувствительных полей
  index.ts         # точка входа
tests/             # Vitest (domain/, telegram/, db/ — интеграционные тесты схемы)
prisma/            # schema.prisma и миграции
docs/              # документация проекта
```

## Версии

TypeScript зафиксирован на `~6.0`, так как `typescript-eslint` пока не поддерживает TypeScript 7.
Prisma — стабильная 7.x (тег `latest` у `prisma` CLI указывает на RC 8.x).
