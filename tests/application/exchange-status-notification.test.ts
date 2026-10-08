import { describe, expect, it } from 'vitest';
import {
  buildExchangeStatusNotification,
  EXCHANGE_STATUS_CHANGED,
  InvalidNotificationError,
  renderNotification,
} from '../../src/application/notifications/exchange-status-notification.js';
import { sanitizeErrorForStorage } from '../../src/application/notifications/sanitize-error.js';
import type { ExchangeRecord } from '../../src/domain/exchanges/exchange.js';
import {
  EXCHANGE_STATUSES,
  type ExchangeStatus,
} from '../../src/domain/exchanges/status-transitions.js';

const EXCHANGE_ID = '0198a2c4-7b1e-7c3a-9d2f-3b5a6c7d8e9f';

function exchange(status: ExchangeStatus): ExchangeRecord {
  return {
    id: EXCHANGE_ID,
    userId: '0198a2c4-7b1e-7c3a-9d2f-000000000001',
    provider: 'MOCK',
    providerExchangeId: 'mock-exchange-1',
    idempotencyKey: 'exchange:key',
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    expectedFromAmount: '100',
    expectedToAmount: '0.001',
    actualFromAmount: null,
    actualToAmount: null,
    payinAddress: 'SECRET-PAYIN-ADDRESS',
    payinExtraId: 'SECRET-PAYIN-MEMO',
    payoutAddress: 'SECRET-PAYOUT-ADDRESS',
    payoutExtraId: 'SECRET-PAYOUT-MEMO',
    refundAddress: 'SECRET-REFUND-ADDRESS',
    refundExtraId: null,
    rateType: 'FLOATING',
    providerRateId: null,
    quoteExpiresAt: null,
    status,
    providerStatus: 'waiting',
    statusChangedAt: new Date(0),
    nextCheckAt: null,
    lastCheckedAt: null,
    checkFailureCount: 0,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

describe('buildExchangeStatusNotification', () => {
  it('создаёт уведомление для статусов, о которых сообщаем пользователю', () => {
    const draft = buildExchangeStatusNotification(exchange('WAITING_DEPOSIT'), 'CONFIRMING');
    expect(draft).toEqual({
      type: EXCHANGE_STATUS_CHANGED,
      payload: {
        exchangeId: EXCHANGE_ID,
        fromStatus: 'WAITING_DEPOSIT',
        toStatus: 'CONFIRMING',
        fromCurrency: 'usdt',
        toCurrency: 'btc',
      },
    });
  });

  it.each(['DRAFT', 'QUOTED', 'AWAITING_CONFIRMATION', 'CREATING'] as const)(
    'не создаёт уведомление для %s',
    (status) => {
      expect(buildExchangeStatusNotification(exchange('DRAFT'), status)).toBeUndefined();
    },
  );

  it('не кладёт адреса и memo в payload', () => {
    for (const status of EXCHANGE_STATUSES) {
      const draft = buildExchangeStatusNotification(exchange('WAITING_DEPOSIT'), status);
      expect(JSON.stringify(draft ?? {})).not.toContain('SECRET');
    }
  });
});

describe('renderNotification', () => {
  const payload = (toStatus: string) => ({
    exchangeId: EXCHANGE_ID,
    fromStatus: 'WAITING_DEPOSIT',
    toStatus,
    fromCurrency: 'usdt',
    toCurrency: 'btc',
  });

  it('формирует текст с парой валют и описанием статуса', () => {
    expect(renderNotification(EXCHANGE_STATUS_CHANGED, payload('FINISHED'))).toBe(
      'Обмен USDT → BTC\nОбмен завершён, средства отправлены на ваш адрес.',
    );
  });

  it('отвергает неизвестный тип', () => {
    expect(() => renderNotification('SOMETHING_ELSE', payload('FINISHED'))).toThrow(
      InvalidNotificationError,
    );
  });

  it.each([
    ['не объект', 'text'],
    ['нет полей', {}],
    ['неизвестный статус', payload('BOGUS')],
    ['статус без шаблона', payload('QUOTED')],
    ['exchangeId не UUID', { ...payload('FINISHED'), exchangeId: 'abc' }],
  ])('отвергает битый payload: %s', (_name, value) => {
    expect(() => renderNotification(EXCHANGE_STATUS_CHANGED, value)).toThrow(
      InvalidNotificationError,
    );
  });

  it('есть шаблон для каждого статуса, который создаёт buildExchangeStatusNotification', () => {
    for (const status of EXCHANGE_STATUSES) {
      const draft = buildExchangeStatusNotification(exchange('WAITING_DEPOSIT'), status);
      if (draft) {
        expect(() => renderNotification(draft.type, draft.payload)).not.toThrow();
      }
    }
  });
});

describe('sanitizeErrorForStorage', () => {
  it('маскирует токен бота', () => {
    const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
    const result = sanitizeErrorForStorage(
      new Error(`request to https://api.telegram.org/bot${token}/sendMessage failed`),
    );
    expect(result).not.toContain(token);
    expect(result).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0');
    expect(result).toContain('[REDACTED]');
  });

  it('маскирует длинные секретоподобные строки', () => {
    const secret = 'a'.repeat(48);
    expect(sanitizeErrorForStorage(`bad key ${secret}`)).not.toContain(secret);
  });

  it('усекает и схлопывает пробелы', () => {
    const result = sanitizeErrorForStorage(`a\n\n  b ${'x '.repeat(500)}`);
    expect(result.length).toBeLessThanOrEqual(200);
    expect(result.startsWith('a b x')).toBe(true);
  });

  it('никогда не возвращает пустую строку', () => {
    expect(sanitizeErrorForStorage(new Error('   '))).toBe('unknown_error');
    expect(sanitizeErrorForStorage(undefined)).toBe('unknown_error');
  });
});
