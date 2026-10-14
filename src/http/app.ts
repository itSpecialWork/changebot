import type { IncomingMessage, ServerResponse } from 'node:http';
import express, { type ErrorRequestHandler, type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../observability/logger.js';
import { createHealthRouter, type HealthCheck } from './health.js';
import { createWidgetPageRouter } from './widget-page.js';

export interface AppDependencies {
  readonly logger: Logger;
  readonly checkDatabase: HealthCheck;
}

export function createApp({ logger, checkDatabase }: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(
    pinoHttp({
      logger,
      // Полный запрос с заголовками в терминале не нужен: это не ошибка и не секрет.
      serializers: {
        req(req: IncomingMessage) {
          return { method: req.method, url: req.url };
        },
        res(res: ServerResponse) {
          return { statusCode: res.statusCode };
        },
      },
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter({ checkDatabase }));
  app.use(createWidgetPageRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: 'Not Found' });
  });

  const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
    req.log.error({ err }, 'Unhandled request error');
    res.status(500).json({ error: 'Internal Server Error' });
  };
  app.use(errorHandler);

  return app;
}
