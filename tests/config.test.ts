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
      changeNowEnabled: false,
      changeNowApiKey: undefined,
      publicBaseUrl: undefined,
    });
  });

  it('приводит числовые значения из строк', () => {
    const config = parseConfig({ ...validEnv, PORT: '8080', SHUTDOWN_TIMEOUT_MS: '5000' });

    expect(config.port).toBe(8080);
    expect(config.shutdownTimeoutMs).toBe(5000);
  });

  describe('TELEGRAM_BOT_TOKEN', () => {
    const token = '1234567890:AAExampleTokenForTestsOnly_0123456789abc';

    it('необязателен: без него бот не запускается', () => {
      expect(parseConfig(validEnv).telegramBotToken).toBeUndefined();
      expect(parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: '' }).telegramBotToken).toBeUndefined();
      expect(
        parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: '  ' }).telegramBotToken,
      ).toBeUndefined();
    });

    it('принимает токен в формате BotFather', () => {
      expect(parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: token }).telegramBotToken).toBe(token);
    });

    it('отклоняет некорректный токен и не раскрывает его значение', () => {
      const broken = 'not-a-real-token-but-secret-looking-value';
      try {
        parseConfig({ ...validEnv, TELEGRAM_BOT_TOKEN: broken });
        expect.unreachable('parseConfig должен выбросить ошибку');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain('TELEGRAM_BOT_TOKEN');
        expect((error as ConfigError).message).not.toContain(broken);
      }
    });
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

  describe('CHANGENOW_ENABLED', () => {
    const secret = 'super-secret-key';

    it('по умолчанию выключен и не сохраняет ключ в конфиге', () => {
      expect(parseConfig(validEnv).changeNowEnabled).toBe(false);
      expect(
        parseConfig({ ...validEnv, CHANGENOW_API_KEY: secret }).changeNowApiKey,
      ).toBeUndefined();
    });

    it('включает провайдер только вместе с ключом', () => {
      const config = parseConfig({
        ...validEnv,
        CHANGENOW_ENABLED: 'true',
        CHANGENOW_API_KEY: secret,
      });

      expect(config.changeNowEnabled).toBe(true);
      expect(config.changeNowApiKey).toBe(secret);
    });

    it('включённый флаг без ключа — ошибка, без отката и без утечки значения', () => {
      try {
        parseConfig({ ...validEnv, CHANGENOW_ENABLED: 'true', CHANGENOW_API_KEY: '   ' });
        expect.unreachable('parseConfig должен выбросить ошибку');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).toContain('CHANGENOW_API_KEY');
      }

      try {
        parseConfig({ ...validEnv, CHANGENOW_ENABLED: secret, CHANGENOW_API_KEY: secret });
        expect.unreachable('parseConfig должен выбросить ошибку');
      } catch (error) {
        expect(error).toBeInstanceOf(ConfigError);
        expect((error as ConfigError).message).not.toContain(secret);
      }
    });
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

  it('принимает публичный https-адрес без пути и отбрасывает пустое значение', () => {
    expect(parseConfig({ ...validEnv, PUBLIC_BASE_URL: '' }).publicBaseUrl).toBeUndefined();
    expect(
      parseConfig({ ...validEnv, PUBLIC_BASE_URL: 'https://exchange.example.com/' }).publicBaseUrl,
    ).toBe('https://exchange.example.com');
  });

  it('не принимает http, путь и не показывает учётные данные в ошибке', () => {
    expect(() => parseConfig({ ...validEnv, PUBLIC_BASE_URL: 'http://127.0.0.1:3000' })).toThrow(
      ConfigError,
    );
    expect(() =>
      parseConfig({ ...validEnv, PUBLIC_BASE_URL: 'https://exchange.example.com/widget' }),
    ).toThrow(ConfigError);

    const secret = 'widget-secret';
    try {
      parseConfig({
        ...validEnv,
        PUBLIC_BASE_URL: `https://user:${secret}@exchange.example.com`,
      });
      expect.unreachable('parseConfig должен выбросить ошибку');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain('PUBLIC_BASE_URL');
      expect((error as ConfigError).message).not.toContain(secret);
    }
  });
});
