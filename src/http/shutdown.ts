import type { Server } from 'node:http';
import type { Logger } from '../observability/logger.js';

export interface ShutdownDependencies {
  readonly server: Server;
  readonly logger: Logger;
  readonly timeoutMs: number;
  /** Освобождение ресурсов после остановки HTTP-сервера (например, Prisma). */
  readonly cleanup: () => Promise<void>;
  /** Заменяется в тестах. */
  readonly exit?: (code: number) => void;
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
    // Не ждём простаивающие keep-alive соединения.
    server.closeIdleConnections();
  });
}

/**
 * Возвращает идемпотентную функцию остановки: перестаёт принимать соединения,
 * дожидается текущих запросов, затем вызывает cleanup. По таймауту завершает процесс принудительно.
 */
export function createShutdown(deps: ShutdownDependencies): (reason: string) => Promise<void> {
  const { server, logger, timeoutMs, cleanup } = deps;
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  let inProgress: Promise<void> | undefined;

  return (reason: string) => {
    inProgress ??= (async () => {
      logger.info({ reason }, 'Shutting down');

      const timer = setTimeout(() => {
        logger.error({ timeoutMs }, 'Graceful shutdown timed out, forcing exit');
        server.closeAllConnections();
        exit(1);
      }, timeoutMs);
      timer.unref();

      try {
        await closeServer(server);
        await cleanup();
        clearTimeout(timer);
        logger.info('Shutdown complete');
        exit(0);
      } catch (error) {
        clearTimeout(timer);
        logger.error({ err: error }, 'Error during shutdown');
        exit(1);
      }
    })();
    return inProgress;
  };
}
