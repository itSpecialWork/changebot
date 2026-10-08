import express, { type ErrorRequestHandler, type Express } from 'express';
import { pinoHttp } from 'pino-http';
import type { Logger } from '../observability/logger.js';
import { createHealthRouter, type HealthCheck } from './health.js';

export interface AppDependencies {
  readonly logger: Logger;
  readonly checkDatabase: HealthCheck;
}

export function createApp({ logger, checkDatabase }: AppDependencies): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(pinoHttp({ logger }));
  app.use(express.json({ limit: '100kb' }));

  app.use(createHealthRouter({ checkDatabase }));

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
