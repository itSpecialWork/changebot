import { describe, expect, it } from 'vitest';
import { ExchangeNotFoundError } from '../../../src/application/exchanges/errors.js';
import { EXCHANGE_STATUS_CHANGED } from '../../../src/application/notifications/exchange-status-notification.js';
import type { ClaimedNotification } from '../../../src/application/notifications/notification-repository.js';
import type { ExchangeRecord } from '../../../src/domain/exchanges/exchange.js';
import { finishedReceiptText } from '../../../src/telegram/notifications/finished-receipt.js';

const EXCHANGE_ID = '0198a2c4-7b1e-7c3a-9d2f-3b5a6c7d8e9f';

function claimed(toStatus: string): ClaimedNotification {
  return {
    id: 'n1',
    userId: 'user-1',
    exchangeId: EXCHANGE_ID,
    type: EXCHANGE_STATUS_CHANGED,
    payload: {
      exchangeId: EXCHANGE_ID,
      fromStatus: 'SENDING',
      toStatus,
      fromCurrency: 'xlm',
      toCurrency: 'xrp',
    },
    attempts: 1,
    telegramId: 1n,
    botBlockedAt: null,
  };
}

describe('finishedReceiptText', () => {
  it('после финала собирает квитанцию, до финала ничего не добавляет', async () => {
    const exchange = {
      id: EXCHANGE_ID,
      fromCurrency: 'xlm',
      fromNetwork: 'xlm',
      toCurrency: 'xrp',
      toNetwork: 'xrp',
      expectedFromAmount: '10',
      expectedToAmount: '20',
      actualFromAmount: '10',
      actualToAmount: '20',
      payoutAddress: 'r-address',
      payoutExtraId: null,
      status: 'FINISHED',
      statusChangedAt: new Date('2026-10-13T01:06:00.000Z'),
      rateType: 'FLOATING',
      quoteExpiresAt: null,
      payinHash: null,
      payoutHash: null,
      refundHash: null,
    } as unknown as ExchangeRecord;

    const text = await finishedReceiptText(
      claimed('FINISHED'),
      () => Promise.resolve(exchange),
      false,
    );
    expect(text).toContain('Квитанция');
    expect(text).toContain('Успешно');
    expect(text).toContain('r-address');

    const earlier = await finishedReceiptText(
      claimed('CONFIRMING'),
      () => Promise.resolve(exchange),
      false,
    );
    expect(earlier).toBeUndefined();
  });

  it('пропавшая заявка не блокирует статусное сообщение', async () => {
    const text = await finishedReceiptText(
      claimed('FINISHED'),
      () => Promise.reject(new ExchangeNotFoundError(EXCHANGE_ID)),
      false,
    );
    expect(text).toBeUndefined();
  });
});
