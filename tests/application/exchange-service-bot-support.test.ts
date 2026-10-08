/**
 * Методы ExchangeService, нужные интерфейсу бота: каталог валют, предпросмотр котировки,
 * подготовка к подтверждению, список и отмена. Репозиторий в памяти, провайдер mock.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExchangeNotCancellableError,
  ExchangeNotFoundError,
  InvalidExchangeInputError,
} from '../../src/application/exchanges/errors.js';
import { ExchangeService } from '../../src/application/exchanges/exchange-service.js';
import { ExchangeProviderError } from '../../src/domain/exchanges/exchange-provider.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';
import { createLogger } from '../../src/observability/logger.js';
import { InMemoryExchangeRepository } from '../telegram/bot/harness.js';

const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });
const PAIR = {
  fromCurrency: 'usdt',
  fromNetwork: 'trx',
  toCurrency: 'btc',
  toNetwork: 'btc',
} as const;

let repository: InMemoryExchangeRepository;
let provider: MockExchangeProvider;
let service: ExchangeService;

function draft(userId: string, clientRequestId: string) {
  return service.createDraft({
    userId,
    clientRequestId,
    ...PAIR,
    fromAmount: '100',
    rateType: 'FLOATING',
    payoutAddress: 'test-payout-address',
  });
}

beforeEach(() => {
  repository = new InMemoryExchangeRepository();
  provider = new MockExchangeProvider();
  service = new ExchangeService({ repository, provider, providerKind: 'MOCK', logger });
});

describe('listCurrencies и previewQuote', () => {
  it('отдаёт каталог провайдера', async () => {
    const currencies = await service.listCurrencies();

    expect(currencies.map((c) => c.ticker)).toContain('usdt');
  });

  it('считает котировку и ничего не сохраняет', async () => {
    const quote = await service.previewQuote({ ...PAIR, fromAmount: '100', rateType: 'FLOATING' });

    expect(quote.toAmount).toBe('0.0016');
    expect(repository.rows.size).toBe(0);
  });

  it('нормализует сумму и отклоняет неверную', async () => {
    const quote = await service.previewQuote({
      ...PAIR,
      fromAmount: '100.500',
      rateType: 'FLOATING',
    });
    expect(quote.fromAmount).toBe('100.5');

    await expect(
      service.previewQuote({ ...PAIR, fromAmount: '-5', rateType: 'FLOATING' }),
    ).rejects.toBeInstanceOf(InvalidExchangeInputError);
    await expect(
      service.previewQuote({ ...PAIR, fromAmount: '0', rateType: 'FLOATING' }),
    ).rejects.toBeInstanceOf(InvalidExchangeInputError);
  });

  it('отдаёт диапазон суммы и ничего не сохраняет', async () => {
    const range = await service.getAmountRange({ ...PAIR, rateType: 'FLOATING' });

    expect(range).toEqual({ minAmount: '0.0001', maxAmount: '1000000' });
    expect(repository.rows.size).toBe(0);
  });

  it('пробрасывает ошибки провайдера', async () => {
    await expect(
      service.previewQuote({ ...PAIR, fromAmount: '0.000001', rateType: 'FLOATING' }),
    ).rejects.toMatchObject({ code: 'AMOUNT_OUT_OF_RANGE' });
    await expect(
      service.previewQuote({
        ...PAIR,
        toCurrency: 'xrp',
        toNetwork: 'xrp',
        fromCurrency: 'btc',
        fromNetwork: 'btc',
        fromAmount: '1',
        rateType: 'FLOATING',
      }),
    ).rejects.toBeInstanceOf(ExchangeProviderError);
  });
});

describe('prepareConfirmation', () => {
  it('доводит черновик до AWAITING_CONFIRMATION', async () => {
    const created = await draft('u1', 'r1');

    const prepared = await service.prepareConfirmation('u1', created.id);

    expect(prepared.status).toBe('AWAITING_CONFIRMATION');
    expect(prepared.expectedToAmount).toBe('0.0016');
  });

  it('безопасно повторяется', async () => {
    const created = await draft('u1', 'r1');
    await service.prepareConfirmation('u1', created.id);

    const again = await service.prepareConfirmation('u1', created.id);

    expect(again.status).toBe('AWAITING_CONFIRMATION');
  });

  it('не работает с чужим обменом', async () => {
    const created = await draft('u1', 'r1');

    await expect(service.prepareConfirmation('u2', created.id)).rejects.toBeInstanceOf(
      ExchangeNotFoundError,
    );
  });
});

describe('cancelByUser', () => {
  it('закрывает обмен до создания у провайдера', async () => {
    const created = await draft('u1', 'r1');
    await service.prepareConfirmation('u1', created.id);

    const cancelled = await service.cancelByUser('u1', created.id);

    expect(cancelled.status).toBe('EXPIRED');
    expect(cancelled.nextCheckAt).toBeNull();
  });

  it('отменяет и обычный черновик', async () => {
    const created = await draft('u1', 'r1');

    expect((await service.cancelByUser('u1', created.id)).status).toBe('EXPIRED');
  });

  it('нельзя отменить обмен, созданный у провайдера', async () => {
    const created = await draft('u1', 'r1');
    await service.prepareConfirmation('u1', created.id);
    await service.confirmAndCreate('u1', created.id);

    await expect(service.cancelByUser('u1', created.id)).rejects.toBeInstanceOf(
      ExchangeNotCancellableError,
    );
  });

  it('нельзя отменить чужой обмен', async () => {
    const created = await draft('u1', 'r1');

    await expect(service.cancelByUser('u2', created.id)).rejects.toBeInstanceOf(
      ExchangeNotFoundError,
    );
  });
});

describe('getForUser и listForUser', () => {
  it('возвращает обмены только владельца', async () => {
    const own = await draft('u1', 'r1');
    await draft('u2', 'r2');

    expect((await service.getForUser('u1', own.id)).id).toBe(own.id);
    await expect(service.getForUser('u2', own.id)).rejects.toBeInstanceOf(ExchangeNotFoundError);
    expect((await service.listForUser('u1', 10)).map((e) => e.id)).toEqual([own.id]);
  });
});
