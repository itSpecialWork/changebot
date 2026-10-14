# Отчёт для проверки базы

Документ для сторонней проверки схемы PostgreSQL до размещения на сервере.
Секретов, паролей, токенов и адресов из живых заявок здесь нет.

Проверка смотрит, что база соответствует описанной модели и отсекает запрещённые строки.
Живой ChangeNOW в эту проверку не входит: флаг `CHANGENOW_ENABLED` оставьте выключенным и заявки у провайдера не создавайте.

## Что является источником истины

PostgreSQL. Prisma описывает таблицы, enum, ключи и индексы в `prisma/schema.prisma`.
CHECK-ограничения и триггер неизменяемости истории Prisma не описывает и при `db pull` их не покажет.
Они лежат в ручном SQL:

- `prisma/migrations/20261008150128_domain_model/migration.sql`
- `prisma/migrations/20261012214700_exchange_transaction_hashes/migration.sql`

Ожидаемые применённые миграции — ровно эти две, в таблице `_prisma_migrations`.
Пересоздавать миграции и гонять `prisma db pull` на этой базе нельзя: ручной SQL при этом теряется.

Те же правила уже покрыты `tests/db/schema-constraints.test.ts`.
Без переменной `TEST_DATABASE_URL` каталог `tests/db` пропускается, это штатно для `npm test` и не значит, что ограничения сняты.

## Состав

Четыре таблицы. Удаление родителя при живых детях запрещено: внешние ключи с `ON DELETE RESTRICT`.
`ON UPDATE CASCADE` на ключах есть, первичные ключи при этом не обновляются приложением.

| Таблица | Роль |
| --- | --- |
| `users` | Пользователь бота. Первичный ключ — внутренний UUID, Telegram ID хранится отдельно. |
| `exchanges` | Заявка обмена или перевода: валюты, сети, суммы, адреса, memo, хэши, статус. |
| `exchange_status_history` | Журнал переходов статуса. Только добавление строк. |
| `notification_outbox` | Очередь уведомлений в Telegram, переживает рестарт процесса. |

Общие соглашения:

- первичные ключи — UUIDv7 (`uuid`, упорядочены по времени);
- даты — `timestamptz(3)`;
- суммы — `numeric(50, 24)`, типа float в колонках нет;
- имена таблиц и колонок — `snake_case`.

Enum в базе: `exchange_provider` (`MOCK`, `CHANGENOW`), `exchange_status`, `rate_type` (`FIXED`, `FLOATING`), `notification_status` (`PENDING`, `PROCESSING`, `SENT`, `FAILED`).

Статусы обмена: `DRAFT`, `QUOTED`, `AWAITING_CONFIRMATION`, `CREATING`, `WAITING_DEPOSIT`, `CONFIRMING`, `EXCHANGING`, `SENDING`, `FINISHED`, `FAILED`, `REFUNDED`, `VERIFYING`, `EXPIRED`.

Уникальность:

- `users.telegram_id`;
- `exchanges.idempotency_key`;
- пара `(provider, provider_exchange_id)` — несколько `NULL` в `provider_exchange_id` допустимы;
- `(exchange_id, sequence)` в истории;
- `notification_outbox.dedupe_key`.

Индексы, на которые опираются списки и worker: `(user_id, created_at DESC)`, `(user_id, status)`, `(status, next_check_at)` у обменов; `(status, next_attempt_at)`, `(status, locked_at)`, `user_id`, `exchange_id` у outbox.

## Что база обязана отвергнуть

Ниже правила уровня PostgreSQL. Проверяющий сверяет их с `pg_constraint` и с отрицательными вставками на пустой тестовой базе.

Пользователь:

- `telegram_id` больше нуля (`users_telegram_id_positive_check`);
- повтор того же `telegram_id` невозможен; это не первичный ключ.

Суммы и строки обмена:

- `expected_from_amount` больше нуля; необязательные суммы либо `NULL`, либо больше нуля (`exchanges_amounts_check`);
- `idempotency_key`, валюты и сети — непустые строки (`exchanges_required_text_check`);
- необязательные тексты (id провайдера, rate id, статус провайдера, адреса, memo/extraId, хэши payin/payout/refund) либо `NULL`, либо непустая строка (`exchanges_optional_text_check`);
- `check_failure_count` не отрицательный.

`NULL` в этих колонках значит «значения нет». Пустая строка туда не записывается. Ведущие нули и регистр приложение хранит как текст, база их не нормализует.

`next_check_at` пуст ровно тогда, когда статус терминальный: `FINISHED`, `FAILED`, `REFUNDED`, `EXPIRED` (`exchanges_next_check_at_check`). `VERIFYING` терминальным не является, срок проверки у него обязателен.

Поля по стадиям:

- в `DRAFT`, `QUOTED`, `AWAITING_CONFIRMATION`, `CREATING`, `EXPIRED` колонка `provider_exchange_id` пуста;
- с `WAITING_DEPOSIT` и дальше по живому обмену (`CONFIRMING`, `EXCHANGING`, `SENDING`, `VERIFYING`, `FINISHED`, `REFUNDED`) она заполнена;
- `FAILED` допускает оба варианта: сбой до id провайдера и сбой после него (`exchanges_provider_exchange_id_stage_check`);
- после выхода из `DRAFT` и для любого статуса кроме `EXPIRED` есть `expected_to_amount` и `quote_expires_at`; у `FIXED` при этом заполнен `provider_rate_id` (`exchanges_quote_stage_check`);
- `provider_rate_id` бывает только у `FIXED` (`exchanges_provider_rate_id_fixed_check`);
- с `AWAITING_CONFIRMATION` заполнен `payout_address`, кроме `DRAFT`, `QUOTED` и `EXPIRED` (`exchanges_payout_stage_check`);
- для `WAITING_DEPOSIT`, `CONFIRMING`, `EXCHANGING`, `SENDING`, `VERIFYING`, `FINISHED` и `REFUNDED` заполнены `payin_address` и `provider_status`; у `FAILED` это ограничение их не требует (`exchanges_deposit_stage_check`);
- `FINISHED` требует `actual_from_amount` и `actual_to_amount` (`exchanges_finished_stage_check`).

История статусов:

- `sequence` начинается с 1;
- `from_status` пуст только у первой строки обмена;
- переход в тот же статус запрещён;
- `reason` непустой, `provider_status` либо `NULL`, либо непустая строка;
- `UPDATE`, `DELETE` и `TRUNCATE` отклоняет триггер `exchange_status_history_immutable` (триггеры `exchange_status_history_no_update_delete` и `exchange_status_history_no_truncate`).

Outbox:

- `attempts` не отрицательный;
- `type` и `dedupe_key` непустые, `last_error` либо `NULL`, либо непустая строка;
- статус `SENT` требует `sent_at`;
- статус `PROCESSING` требует `locked_at`.

Удаление:

- пользователя с обменами или уведомлениями удалить нельзя;
- обмен с историей или уведомлениями удалить нельзя.

## Чего в CHECK нет

Граф допустимых переходов статусов живёт в приложении: `src/domain/exchanges/status-transitions.ts`.
База хранит enum и пишет историю, но сама не запрещает, например, прыжок `DRAFT` → `FINISHED`, если вставлены все поля стадии.
Переходы выполняет только `ExchangeService`; список статусов в коде и в enum сверяет `tests/domain/exchange-status-sync.test.ts`.

Колонка `notification_outbox.payload` — `json`. База не смотрит её состав.
Приложение кладёт туда тип `EXCHANGE_STATUS_CHANGED` и поля `exchangeId`, `fromStatus`, `toStatus`, `fromCurrency`, `toCurrency` (`src/application/notifications/exchange-status-notification.ts`).
Адреса, memo, хэши, суммы и данные провайдера в payload не входят. Это правило кода, не ограничение PostgreSQL: произвольный JSON в колонку вставить можно.

Захват заявок worker-ом идёт через `FOR UPDATE SKIP LOCKED` и сдвиг `next_check_at`. Это запрос приложения, отдельного ограничения в схеме нет.

Приватных ключей и seed-фраз в схеме нет. В таблицах лежат данные заявки: Telegram ID, имя, адреса payin/payout/refund, memo/extraId и хэши транзакций. Это не секреты кошелька пользователя: средства уходят на адрес провайдера, приложение их не хранит.

## Как проверить локально

Нужны Node.js >= 22.18, npm и Docker. Рабочая копия репозитория, отдельная пустая база.
Боевую базу и файл `.env` с ключами для этой проверки не используйте.

1. Поднять Postgres: `npm run db:up` (образ `postgres:18-alpine`, порт только на `127.0.0.1`).
2. Создать базу с именем на `_test`, например `changenow_test`. Имя без этого суффикса тесты отвергнут.
3. Задать `TEST_DATABASE_URL` на эту базу. `npm test` сам файл `.env` не читает, переменную нужно передать в окружение.
4. Запустить `npm test`. Перед тестами `tests/db` клиент сам выполняет `prisma migrate deploy` на `TEST_DATABASE_URL`.

Ожидаемый смысл прогона: модульные тесты проходят, интеграционные `tests/db` тоже проходят и больше не числятся пропущенными.
Живые флаги при этом не включаются.

Сверить ограничения можно и прямым запросом к тестовой базе:

```sql
SELECT c.conrelid::regclass AS table_name, c.conname, pg_get_constraintdef(c.oid)
FROM pg_constraint c
WHERE c.conrelid IN (
  'users'::regclass,
  'exchanges'::regclass,
  'exchange_status_history'::regclass,
  'notification_outbox'::regclass
)
ORDER BY 1, 2;

SELECT tgname, pg_get_triggerdef(oid)
FROM pg_trigger
WHERE tgrelid = 'exchange_status_history'::regclass
  AND NOT tgisinternal;
```

Имена CHECK из этого отчёта должны присутствовать. Функция `exchange_status_history_immutable` должна отклонять `UPDATE`, `DELETE` и `TRUNCATE`.
