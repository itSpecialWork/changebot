import { describe, expect, it } from 'vitest';
import { ConfigError, type AppConfig } from '../src/config/env.js';
import { selectPrivateTransferProvider } from '../src/compose.js';
import { ChangeNowPrivateTransferProvider } from '../src/integrations/changenow/change-now-private-transfer-provider.js';
import { MockPrivateTransferProvider } from '../src/integrations/mock/mock-private-transfer-provider.js';

function config(
  patch: Pick<AppConfig, 'changeNowEnabled' | 'changeNowApiKey' | 'privateTransferEnabled'>,
): AppConfig {
  return {
    nodeEnv: 'test',
    host: '127.0.0.1',
    port: 3000,
    logLevel: 'silent',
    shutdownTimeoutMs: 1000,
    databaseUrl: 'postgresql://user:pass@127.0.0.1:5432/db',
    telegramBotToken: undefined,
    publicBaseUrl: undefined,
    ...patch,
  };
}

describe('selectPrivateTransferProvider', () => {
  it('без флага не создаёт провайдер, даже если обмен живой', () => {
    const selected = selectPrivateTransferProvider(
      config({
        changeNowEnabled: true,
        changeNowApiKey: 'test-api-key',
        privateTransferEnabled: false,
      }),
    );

    expect(selected).toBeUndefined();
  });

  it('с флагом и тестовым обменом выбирает мок', () => {
    const selected = selectPrivateTransferProvider(
      config({
        changeNowEnabled: false,
        changeNowApiKey: undefined,
        privateTransferEnabled: true,
      }),
    );

    expect(selected).toBeInstanceOf(MockPrivateTransferProvider);
  });

  it('с флагом и живым обменом берёт тот же ключ', () => {
    const selected = selectPrivateTransferProvider(
      config({
        changeNowEnabled: true,
        changeNowApiKey: 'test-api-key',
        privateTransferEnabled: true,
      }),
    );

    expect(selected).toBeInstanceOf(ChangeNowPrivateTransferProvider);
  });

  it('включённый живой обмен без ключа не подменяет перевод моком', () => {
    expect(() =>
      selectPrivateTransferProvider(
        config({
          changeNowEnabled: true,
          changeNowApiKey: undefined,
          privateTransferEnabled: true,
        }),
      ),
    ).toThrow(ConfigError);
  });
});
