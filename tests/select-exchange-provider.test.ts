import { describe, expect, it } from 'vitest';
import { ConfigError, type AppConfig } from '../src/config/env.js';
import { selectExchangeProvider } from '../src/compose.js';
import { ChangeNowExchangeProvider } from '../src/integrations/changenow/change-now-exchange-provider.js';
import { MockExchangeProvider } from '../src/integrations/mock/mock-exchange-provider.js';

function config(patch: Pick<AppConfig, 'changeNowEnabled' | 'changeNowApiKey'>): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3000,
    logLevel: 'silent',
    shutdownTimeoutMs: 1000,
    databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/db',
    telegramBotToken: undefined,
    privateTransferEnabled: false,
    ...patch,
  };
}

describe('selectExchangeProvider', () => {
  it('по умолчанию оставляет мок и демо-кнопку', () => {
    const selected = selectExchangeProvider(
      config({ changeNowEnabled: false, changeNowApiKey: undefined }),
    );

    expect(selected.provider).toBeInstanceOf(MockExchangeProvider);
    expect(selected.providerKind).toBe('MOCK');
    expect(selected.demo).toBeDefined();
  });

  it('с флагом и ключом выбирает ChangeNOW без демо', () => {
    const selected = selectExchangeProvider(
      config({ changeNowEnabled: true, changeNowApiKey: 'test-api-key' }),
    );

    expect(selected.provider).toBeInstanceOf(ChangeNowExchangeProvider);
    expect(selected.providerKind).toBe('CHANGENOW');
    expect(selected.demo).toBeUndefined();
  });

  it('включённый флаг без ключа не подменяет провайдер моком', () => {
    expect(() =>
      selectExchangeProvider(config({ changeNowEnabled: true, changeNowApiKey: undefined })),
    ).toThrow(ConfigError);
  });
});
