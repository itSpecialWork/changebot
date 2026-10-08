import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Формат токена BotFather: `<числовой id бота>:<секрет>`. Сообщение об ошибке
 * не содержит значения, чтобы токен не попал в логи.
 */
const telegramTokenSchema = z
  .string()
  .trim()
  .regex(
    /^\d{5,}:[A-Za-z0-9_-]{30,}$/,
    'must look like "<bot id>:<secret>" (token from @BotFather)',
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Пустое значение (`TELEGRAM_BOT_TOKEN=`) равносильно отсутствию: бот не запускается.
  TELEGRAM_BOT_TOKEN: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    telegramTokenSchema.optional(),
  ),
});

export interface AppConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: (typeof logLevels)[number];
  readonly shutdownTimeoutMs: number;
  readonly databaseUrl: string;
  /** Токен Telegram-бота. Не задан — бот и связанные с ним worker'ы не запускаются. */
  readonly telegramBotToken: string | undefined;
}

/**
 * Ошибка конфигурации. Сообщение содержит только имена переменных и причины,
 * но никогда не значения (в них могут быть пароли).
 */
export class ConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function parseConfig(source: Readonly<Record<string, string | undefined>>): AppConfig {
  const result = envSchema.safeParse(source);

  if (!result.success) {
    throw new ConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = result.data;
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
  });
}
