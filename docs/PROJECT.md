# ChangeNOW Telegram Exchange

## Цель

Production-сервис некостодиального обмена криптовалют через ChangeNOW API.

Пользователь отправляет средства непосредственно на адрес ChangeNOW. Приложение не хранит приватные ключи, seed-фразы и пользовательские средства.

Основной интерфейс — Telegram-бот. После готовности MVP добавляется Telegram Mini App.

## Монетизация

Сервис использует партнёрский ChangeNOW API и получает комиссию с подходящих успешно завершённых обменов. Реклама и дополнительные способы монетизации не входят в первый MVP.

## Стек

- Node.js LTS
- TypeScript strict
- grammY
- Express
- PostgreSQL
- Prisma
- Zod
- Vitest
- Pino
- Docker Compose
- Vite + React для будущего Telegram Mini App

Redis на первом этапе не используется.

## Архитектура

Используется модульный монолит:

- Telegram является интерфейсным адаптером.
- Express является HTTP-адаптером.
- Бизнес-логика находится в application/domain.
- ChangeNOW подключается через интерфейс ExchangeProvider.
- PostgreSQL является источником истины.
- Фоновый worker проверяет статусы активных обменов.
- Уведомления отправляются через persistent outbox.

Предполагаемая структура:

src/
application/
exchanges/
users/
notifications/
domain/
exchanges/
users/
shared/
telegram/
bot/
notifications/
integrations/
changenow/
database/
repositories/
prisma/
workers/
http/
config/
observability/

tests/
docs/
prisma/

## Основные правила

- Не помещать бизнес-логику в grammY handlers и Express routes.
- Не обращаться к ChangeNOW непосредственно из Telegram handlers.
- Использовать dependency inversion для внешних провайдеров.
- Использовать внутренний UUID пользователя.
- Telegram ID хранить отдельно как BigInt с unique constraint.
- Криптовалютные суммы хранить только как Decimal или строки.
- Никогда не использовать Float для денег.
- Учитывать не только валюту, но и blockchain network.
- Учитывать memo, tag и extraId.
- Внешние ответы валидировать через Zod.
- Все реальные операции должны быть выключены по умолчанию feature flag.
- Тесты должны использовать mock provider и fixtures.
- Не хранить и не логировать API-ключи, токены и приватные данные.
- После каждого изменения запускать lint, typecheck и tests.

## Модель обмена

Основные сущности:

- User
- Exchange
- ExchangeStatusHistory
- NotificationOutbox
- ExchangeDraft при необходимости

Exchange содержит:

- внутренний UUID;
- provider;
- providerExchangeId;
- idempotencyKey;
- валюты и сети;
- точные суммы;
- адреса payin, payout и refund;
- memo/tag/extraId;
- fixed или floating rate;
- срок действия котировки;
- текущий внутренний статус;
- оригинальный статус провайдера;
- timestamps.

## Статусы

Основной поток:

DRAFT
→ QUOTED
→ AWAITING_CONFIRMATION
→ CREATING
→ WAITING_DEPOSIT
→ CONFIRMING
→ EXCHANGING
→ SENDING
→ FINISHED

Дополнительные состояния:

- FAILED
- REFUNDED
- VERIFYING
- EXPIRED

Переходы статусов выполняются только через ExchangeService и сохраняются в ExchangeStatusHistory.

## Интеграция ChangeNOW

Должен существовать интерфейс ExchangeProvider:

- getCurrencies
- getQuote
- createExchange
- getExchangeStatus

Сначала реализуется MockExchangeProvider. Реальный ChangeNOW-клиент добавляется отдельным адаптером.

На первом этапе статус проверяется polling worker. Webhook добавляется только после получения официальной документации о payload, проверке подлинности и повторной доставке.

## Безопасность

- Никогда не хранить seed-фразы и приватные ключи.
- Не выполнять реальные обмены в автоматических тестах.
- Не доверять данным Telegram Mini App без серверной проверки initData.
- Защищаться от повторного нажатия и повторной доставки событий.
- Использовать таймауты, retry с ограничениями и rate limiting.
- Маскировать чувствительные данные в логах.
- Не держать транзакцию PostgreSQL открытой во время HTTP-запроса.
- Реальные обмены включаются только вручную.

## Будущие кошельки

ChangeNOW Custody/Wallet API позднее подключается через отдельный WalletProvider.

Будущие модули:

- domain/wallets
- application/wallets
- integrations/changenow/custody

Текущая реализация не должна заранее создавать таблицы кошельков без официальной документации API.
