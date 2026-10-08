/**
 * Composition root: сборка сервисов, репозиториев, worker'ов и бота.
 *
 * Провайдер один на процесс. По умолчанию это мок. ChangeNOW подключается только
 * при CHANGENOW_ENABLED=true и ключе из окружения. Демо-кнопка есть только у мока.
 *
 * Без TELEGRAM_BOT_TOKEN бот и worker'ы не запускаются (остаются HTTP и БД).
 */
import type { Bot } from 'grammy';
import { ExchangeService } from './application/exchanges/exchange-service.js';
import { NotificationService } from './application/notifications/notification-service.js';
import { UserService } from './application/users/user-service.js';
import { BOT_COMMANDS, createBot, describeErrorForLog } from './telegram/bot/create-bot.js';
import type { BotContext } from './telegram/bot/context.js';
import { ConfigError, type AppConfig } from './config/env.js';
import type { PrismaClient } from './database/prisma.js';
import { PrismaExchangeRepository } from './database/repositories/prisma-exchange-repository.js';
import { PrismaNotificationOutboxRepository } from './database/repositories/prisma-notification-outbox-repository.js';
import { PrismaUserRepository } from './database/repositories/prisma-user-repository.js';
import type { ExchangeProvider } from './domain/exchanges/exchange-provider.js';
import type { ExchangeProviderKind } from './domain/exchanges/exchange.js';
import { ChangeNowExchangeProvider } from './integrations/changenow/change-now-exchange-provider.js';
import { MockExchangeProvider } from './integrations/mock/mock-exchange-provider.js';
import { TelegramNotificationSender } from './telegram/notifications/telegram-notification-sender.js';
import type { DemoControls } from './telegram/bot/context.js';
import type { Logger } from './observability/logger.js';
import { ExchangeStatusWorker } from './workers/exchange-status-worker.js';
import { NotificationOutboxWorker } from './workers/notification-outbox-worker.js';

/**
 * Параметры worker'ов. Lock TTL уведомлений (5 минут по умолчанию) должен превышать
 * время обработки пакета: batchSize × (sendTimeout + пауза) = 20 × ~10 с в худшем случае.
 * При увеличении batchSize пересчитайте lock TTL. Позднее значения можно вынести в env.
 */
const EXCHANGE_POLL_INTERVAL_MS = 5_000;
const EXCHANGE_POLL_BATCH_SIZE = 20;
const OUTBOX_INTERVAL_MS = 2_000;
const OUTBOX_BATCH_SIZE = 20;

export interface Application {
  /** Запускает бота и worker'ы. Фатальные ошибки (например, неверный токен) идут в onFatalError. */
  start(): void;
  /** Останавливает бота и дожидается завершения текущих проходов worker'ов. */
  stop(): Promise<void>;
}

export interface ApplicationOptions {
  readonly config: AppConfig;
  readonly prisma: PrismaClient;
  readonly logger: Logger;
  readonly onFatalError: (error: unknown) => void;
}

export interface SelectedExchangeProvider {
  readonly provider: ExchangeProvider;
  readonly providerKind: ExchangeProviderKind;
  readonly demo?: DemoControls;
}

/** Выбирает единственный провайдер процесса. Без ключа при включённом флаге не стартует. */
export function selectExchangeProvider(config: AppConfig): SelectedExchangeProvider {
  if (config.changeNowEnabled) {
    const apiKey = config.changeNowApiKey;
    if (apiKey === undefined) {
      throw new ConfigError(['CHANGENOW_API_KEY: is required when CHANGENOW_ENABLED is true']);
    }
    return {
      provider: new ChangeNowExchangeProvider({ apiKey }),
      providerKind: 'CHANGENOW',
    };
  }

  const provider = new MockExchangeProvider();
  return {
    provider,
    providerKind: 'MOCK',
    demo: {
      advanceProviderStatus: (id) => {
        provider.advanceStatus(id);
      },
    },
  };
}

export function createApplication(options: ApplicationOptions): Application {
  const { config, prisma, logger } = options;

  const token = config.telegramBotToken;
  if (token === undefined) {
    return {
      start: () => {
        logger.warn(
          'TELEGRAM_BOT_TOKEN is not set: Telegram bot and background workers are disabled',
        );
      },
      stop: () => Promise.resolve(),
    };
  }

  const selected = selectExchangeProvider(config);
  const exchanges = new ExchangeService({
    repository: new PrismaExchangeRepository(prisma),
    provider: selected.provider,
    providerKind: selected.providerKind,
    logger,
  });
  const users = new UserService(new PrismaUserRepository(prisma));

  const bot = createBot({
    token,
    exchanges,
    users,
    logger,
    ...(selected.demo ? { demo: selected.demo } : {}),
  });

  const notifications = new NotificationService({
    repository: new PrismaNotificationOutboxRepository(prisma),
    sender: new TelegramNotificationSender(bot.api),
    logger,
  });
  const exchangeWorker = new ExchangeStatusWorker({
    poller: exchanges,
    logger,
    intervalMs: EXCHANGE_POLL_INTERVAL_MS,
    batchSize: EXCHANGE_POLL_BATCH_SIZE,
  });
  const outboxWorker = new NotificationOutboxWorker({
    dispatcher: notifications,
    logger,
    intervalMs: OUTBOX_INTERVAL_MS,
    batchSize: OUTBOX_BATCH_SIZE,
  });

  return {
    start() {
      exchangeWorker.start();
      outboxWorker.start();
      startPolling(bot, logger, options.onFatalError);
    },
    async stop() {
      await bot.stop();
      await exchangeWorker.stop();
      await outboxWorker.stop();
    },
  };
}

function startPolling(
  bot: Bot<BotContext>,
  logger: Logger,
  onFatalError: (error: unknown) => void,
): void {
  bot
    .start({
      allowed_updates: ['message', 'callback_query'],
      onStart: (info) => {
        logger.info({ username: info.username }, 'Telegram bot started (long polling)');
        bot.api.setMyCommands([...BOT_COMMANDS]).catch((error: unknown) => {
          logger.warn({ err: describeErrorForLog(error) }, 'Could not set bot commands');
        });
      },
    })
    .catch((error: unknown) => {
      logger.fatal({ err: describeErrorForLog(error) }, 'Telegram bot stopped with an error');
      onFatalError(error);
    });
}
