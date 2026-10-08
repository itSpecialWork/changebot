import { pino, type Logger } from 'pino';
import type { AppConfig } from '../config/env.js';

export type { Logger };

/** Пути, значения которых маскируются в логах. */
export const redactPaths = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.apiKey',
  '*.secret',
  '*.databaseUrl',
  '*.DATABASE_URL',
  '*.telegramBotToken',
  '*.TELEGRAM_BOT_TOKEN',
  '*.changeNowApiKey',
  '*.CHANGENOW_API_KEY',
  'password',
  'token',
  'apiKey',
  'secret',
  'databaseUrl',
  'DATABASE_URL',
  'telegramBotToken',
  'TELEGRAM_BOT_TOKEN',
  'changeNowApiKey',
  'CHANGENOW_API_KEY',
  'req.headers["x-changenow-api-key"]',
  'headers["x-changenow-api-key"]',
  '*.headers["x-changenow-api-key"]',
];

export function createLogger(config: Pick<AppConfig, 'nodeEnv' | 'logLevel'>): Logger {
  return pino({
    level: config.nodeEnv === 'test' ? 'silent' : config.logLevel,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
