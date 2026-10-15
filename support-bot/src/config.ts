import { z } from 'zod';

const logLevels = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

/**
 * Формат токена BotFather. Сообщение об ошибке не содержит значения.
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

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(logLevels).default('info'),
  DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
  SUPPORT_BOT_TOKEN: z.preprocess(emptyToUndefined, telegramTokenSchema),
  SUPPORT_ADMIN_PASSWORD: z.preprocess(emptyToUndefined, z.string().trim().min(1, 'is required')),
});

export interface SupportConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly logLevel: (typeof logLevels)[number];
  readonly databaseUrl: string;
  readonly token: string;
  readonly password: string;
}

/** Ошибка конфигурации. В тексте только имена переменных, не их значения. */
export class SupportConfigError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Invalid support bot configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`,
    );
    this.name = 'SupportConfigError';
  }
}

export function parseSupportConfig(
  source: Readonly<Record<string, string | undefined>>,
): SupportConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    throw new SupportConfigError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }

  const env = result.data;
  return Object.freeze({
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    token: env.SUPPORT_BOT_TOKEN,
    password: env.SUPPORT_ADMIN_PASSWORD,
  });
}
