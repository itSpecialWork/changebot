import { config as loadDotenv } from 'dotenv';
import { createApplication } from './compose.js';
import { ConfigError, parseConfig, type AppConfig } from './config/env.js';
import { createPrismaClient, pingDatabase } from './database/prisma.js';
import { createApp } from './http/app.js';
import { createShutdown } from './http/shutdown.js';
import { createLogger } from './observability/logger.js';

loadDotenv({ quiet: true });

function loadConfig(): AppConfig {
  try {
    return parseConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function main(): void {
  const config = loadConfig();
  const logger = createLogger(config);
  const prisma = createPrismaClient(config.databaseUrl);
  const app = createApp({ logger, checkDatabase: () => pingDatabase(prisma) });

  const server = app.listen(config.port, config.host, () => {
    logger.info({ host: config.host, port: config.port }, 'HTTP server listening');
  });

  server.on('error', (error) => {
    logger.fatal({ err: error }, 'HTTP server error');
    process.exit(1);
  });

  const application = createApplication({
    config,
    prisma,
    logger,
    onFatalError: () => void shutdown('botFatalError'),
  });

  const shutdown = createShutdown({
    server,
    logger,
    timeoutMs: config.shutdownTimeoutMs,
    cleanup: async () => {
      await application.stop();
      await prisma.$disconnect();
    },
  });

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.fatal({ err: reason }, 'Unhandled promise rejection');
    void shutdown('unhandledRejection');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception');
    void shutdown('uncaughtException');
  });

  application.start();
}

main();
