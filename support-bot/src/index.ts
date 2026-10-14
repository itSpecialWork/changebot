/**
 * Отдельный процесс поддержки. Обменный бот этот файл не запускает.
 */
import { config as loadDotenv } from 'dotenv';
import { createSupportBot } from './bot.js';
import { parseSupportConfig, SupportConfigError } from './config.js';
import { createSupportLogger } from './logger.js';
import { PrismaSupportLookup } from './prisma-lookup.js';
import { createPrismaClient } from '../../src/database/prisma.js';

// override: адрес базы берётся из .env этого репозитория, а не из старой переменной оболочки.
loadDotenv({ quiet: true, override: true });

function main(): void {
  let config;
  try {
    config = parseSupportConfig(process.env);
  } catch (error) {
    if (error instanceof SupportConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createSupportLogger(config);
  const prisma = createPrismaClient(config.databaseUrl);
  const bot = createSupportBot({
    token: config.token,
    password: config.password,
    lookup: new PrismaSupportLookup(prisma),
    logger,
  });

  let stopping = false;
  const stop = (reason: string, code: number): void => {
    if (stopping) return;
    stopping = true;
    logger.info({ reason }, 'Support bot shutting down');
    void bot
      .stop()
      .catch((error: unknown) => {
        logger.error(
          { name: error instanceof Error ? error.name : 'Error' },
          'Support bot stop failed',
        );
      })
      .finally(() => {
        void prisma.$disconnect().finally(() => {
          process.exit(code);
        });
      });
  };

  process.on('SIGINT', () => {
    stop('SIGINT', 0);
  });
  process.on('SIGTERM', () => {
    stop('SIGTERM', 0);
  });

  void bot
    .start({
      allowed_updates: ['message'],
      onStart: (info) => {
        logger.info({ username: info.username }, 'Support bot started');
      },
    })
    .catch((error: unknown) => {
      logger.fatal(
        { name: error instanceof Error ? error.name : 'Error' },
        'Support bot stopped with an error',
      );
      stop('fatal', 1);
    });
}

main();
