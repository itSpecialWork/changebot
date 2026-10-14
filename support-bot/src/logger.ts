import { pino, type Logger } from 'pino';
import type { SupportConfig } from './config.js';

export type { Logger };

const redactPaths = [
  'password',
  'token',
  'databaseUrl',
  'DATABASE_URL',
  'SUPPORT_BOT_TOKEN',
  'SUPPORT_ADMIN_PASSWORD',
  '*.password',
  '*.token',
  '*.databaseUrl',
  '*.DATABASE_URL',
  '*.SUPPORT_BOT_TOKEN',
  '*.SUPPORT_ADMIN_PASSWORD',
];

export function createSupportLogger(config: Pick<SupportConfig, 'nodeEnv' | 'logLevel'>): Logger {
  return pino({
    level: config.nodeEnv === 'test' ? 'silent' : config.logLevel,
    redact: { paths: redactPaths, censor: '[REDACTED]' },
    ...(config.nodeEnv === 'development'
      ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
      : {}),
  });
}
