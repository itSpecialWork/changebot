import { describe, expect, it } from 'vitest';
import { ConfigError, parseConfig } from '../src/config/env.js';

const validEnv = {
  DATABASE_URL: 'postgresql://user:secret-pass@127.0.0.1:5432/db?schema=public',
};

describe('parseConfig', () => {
  it('применяет значения по умолчанию', () => {
    const config = parseConfig(validEnv);

    expect(config).toMatchObject({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 3000,
      logLevel: 'info',
      shutdownTimeoutMs: 10_000,
      databaseUrl: validEnv.DATABASE_URL,
    });
  });

  it('приводит числовые значения из строк', () => {
    const config = parseConfig({ ...validEnv, PORT: '8080', SHUTDOWN_TIMEOUT_MS: '5000' });

    expect(config.port).toBe(8080);
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  it('требует DATABASE_URL', () => {
    expect(() => parseConfig({})).toThrow(ConfigError);
  });

  it('отклоняет DATABASE_URL с неподходящим протоколом', () => {
    expect(() => parseConfig({ DATABASE_URL: 'mysql://user:pass@localhost/db' })).toThrow(
      ConfigError,
    );
  });

  it('отклоняет некорректный порт и уровень логов', () => {
    expect(() => parseConfig({ ...validEnv, PORT: '70000' })).toThrow(ConfigError);
    expect(() => parseConfig({ ...validEnv, LOG_LEVEL: 'verbose' })).toThrow(ConfigError);
  });

  it('не раскрывает значения переменных в сообщении об ошибке', () => {
    const secretUrl = 'mysql://user:super-secret@localhost/db';

    try {
      parseConfig({ DATABASE_URL: secretUrl });
      expect.unreachable('parseConfig должен выбросить ошибку');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('DATABASE_URL');
      expect((error as ConfigError).message).not.toContain('super-secret');
    }
  });
});
