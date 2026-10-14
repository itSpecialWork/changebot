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

const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** Пустое значение и отсутствие равны `false`. Другие строки — ошибка конфигурации. */
const featureFlagSchema = z.preprocess(
  (value) =>
    value === undefined || (typeof value === 'string' && value.trim() === '') ? 'false' : value,
  z.enum(['true', 'false'], { error: 'must be true or false' }),
);

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().trim().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  // Пустое значение (`TELEGRAM_BOT_TOKEN=`) равносильно отсутствию: бот не запускается.
  TELEGRAM_BOT_TOKEN: z.preprocess(emptyToUndefined, telegramTokenSchema.optional()),
  /**
   * Живой ChangeNOW выключен, пока флаг не равен строке `true`.
   * Сообщение об ошибке не включает переданное значение.
   */
  CHANGENOW_ENABLED: featureFlagSchema,
  // Пустое значение равносильно отсутствию ключа. Сам ключ в ошибку не попадает.
  CHANGENOW_API_KEY: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
  /**
   * Публичный https-адрес без пути. Пустое значение — страницу виджета бот не открывает.
   * Сам адрес в сообщение об ошибке не попадает.
   */
  PUBLIC_BASE_URL: z.preprocess(emptyToUndefined, z.string().trim().min(1).optional()),
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
  /** true — ChangeNOW API v2. false — тестовый провайдер в памяти. */
  readonly changeNowEnabled: boolean;
  /**
   * Ключ ChangeNOW. Заполнен только при включённом флаге обмена.
   * При выключенном флаге отбрасывается, чтобы не лежать в объекте конфигурации.
   */
  readonly changeNowApiKey: string | undefined;
  /**
   * Origin страницы виджета, без пути и без учётных данных.
   * Кнопка меню открывает эту страницу ссылкой в браузере.
   * Нет значения — ссылка ведёт на http://127.0.0.1:<порт>/widget.
   */
  readonly publicBaseUrl: string | undefined;
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
  const changeNowEnabled = env.CHANGENOW_ENABLED === 'true';
  if (changeNowEnabled && env.CHANGENOW_API_KEY === undefined) {
    throw new ConfigError(['CHANGENOW_API_KEY: is required when CHANGENOW_ENABLED is true']);
  }

  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    shutdownTimeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    databaseUrl: env.DATABASE_URL,
    telegramBotToken: env.TELEGRAM_BOT_TOKEN,
    changeNowEnabled,
    changeNowApiKey: changeNowEnabled ? env.CHANGENOW_API_KEY : undefined,
    publicBaseUrl: publicBaseOrigin(env.PUBLIC_BASE_URL),
  });
}

/** https-origin без пути, запроса и учётных данных. Значение в текст ошибки не входит. */
function publicBaseOrigin(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(['PUBLIC_BASE_URL: must be an https origin']);
  }

  const bareOrigin =
    url.protocol === 'https:' &&
    url.username === '' &&
    url.password === '' &&
    (url.pathname === '/' || url.pathname === '') &&
    url.search === '' &&
    url.hash === '';
  if (!bareOrigin) {
    throw new ConfigError(['PUBLIC_BASE_URL: must be an https origin without a path']);
  }

  return url.origin;
}
