import { describe, expect, it } from 'vitest';
import { parseSupportConfig, SupportConfigError } from '../src/config.js';

const token = '1234567890:AAExampleTokenForTestsOnly_0123456789abc';
const password = 'support-test-password';
const databaseUrl = 'postgresql://user:secret-pass@127.0.0.1:5432/db?schema=public';

const validEnv = {
  DATABASE_URL: databaseUrl,
  SUPPORT_BOT_TOKEN: token,
  SUPPORT_ADMIN_PASSWORD: password,
};

describe('parseSupportConfig', () => {
  it('читает базу, токен и пароль', () => {
    expect(parseSupportConfig(validEnv)).toMatchObject({
      nodeEnv: 'development',
      logLevel: 'info',
      databaseUrl,
      token,
      password,
    });
  });

  it('считает пустой пароль отсутствующим и не пишет его в ошибку', () => {
    const leaked = '   ';
    try {
      parseSupportConfig({ ...validEnv, SUPPORT_ADMIN_PASSWORD: leaked });
      expect.unreachable('пустой пароль должен остановить разбор');
    } catch (error) {
      expect(error).toBeInstanceOf(SupportConfigError);
      expect((error as SupportConfigError).message).toContain('SUPPORT_ADMIN_PASSWORD');
      expect((error as SupportConfigError).message).not.toContain('secret-pass');
    }
  });

  it('отклоняет токен и не раскрывает его значение', () => {
    const broken = 'not-a-real-token-but-secret-looking-value';
    try {
      parseSupportConfig({ ...validEnv, SUPPORT_BOT_TOKEN: broken });
      expect.unreachable('битый токен должен остановить разбор');
    } catch (error) {
      expect(error).toBeInstanceOf(SupportConfigError);
      expect((error as SupportConfigError).message).toContain('SUPPORT_BOT_TOKEN');
      expect((error as SupportConfigError).message).not.toContain(broken);
    }
  });

  it('не пишет пароль из адреса базы в ошибку протокола', () => {
    const url = 'mysql://user:super-secret-db@127.0.0.1/db';
    try {
      parseSupportConfig({ ...validEnv, DATABASE_URL: url });
      expect.unreachable('чужой протокол должен остановить разбор');
    } catch (error) {
      expect(error).toBeInstanceOf(SupportConfigError);
      expect((error as SupportConfigError).message).toContain('DATABASE_URL');
      expect((error as SupportConfigError).message).not.toContain('super-secret-db');
    }
  });
});
