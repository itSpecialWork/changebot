/**
 * Методы ExchangeService, нужные интерфейсу бота: каталог валют, предпросмотр котировки,
 * подготовка к подтверждению, список и отмена. Репозиторий в памяти, провайдер mock.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('срок без кнопки пользователя', () => {
  const start = new Date('2026-01-01T00:00:00.000Z');
  let now: Date;
  let clockedRepository: InMemoryExchangeRepository;
  let clocked: ExchangeService;

  beforeEach(() => {
    now = start;
    clockedRepository = new InMemoryExchangeRepository();
    clocked = new ExchangeService({
      repository: clockedRepository,
      provider: new MockExchangeProvider({ now: () => now }),
      providerKind: 'MOCK',
      logger,
      now: () => now,
    });
  });

  async function awaiting(): Promise<string> {
    const created = await clocked.createDraft({
      userId: 'u1',
      clientRequestId: 'r1',
      ...PAIR,
      fromAmount: '100',
      rateType: 'FLOATING',
      payoutAddress: 'test-payout-address',
    });
    const prepared = await clocked.prepareConfirmation('u1', created.id);
    return prepared.id;
  }

  it('по истечении котировки worker ставит EXPIRED с причиной quote_expired', async () => {
    const id = await awaiting();
    const transition = vi.spyOn(clockedRepository, 'transition');
    now = new Date(start.getTime() + 5 * 60_000);

    const summary = await clocked.pollDueExchanges(10);

    expect(summary.transitioned).toBe(1);
    expect(clockedRepository.rows.get(id)?.status).toBe('EXPIRED');
    expect(clockedRepository.rows.get(id)?.nextCheckAt).toBeNull();
    expect(transition).toHaveBeenCalledWith(
      expect.objectContaining({
        exchangeId: id,
        from: 'AWAITING_CONFIRMATION',
        to: 'EXPIRED',
        reason: 'quote_expired',
        notification: expect.objectContaining({ type: 'EXCHANGE_STATUS_CHANGED' }) as object,
      }),
    );
  });

  it('до срока отмена остаётся user_cancelled и без уведомления', async () => {
    const id = await awaiting();
    const transition = vi.spyOn(clockedRepository, 'transition');

    await clocked.cancelByUser('u1', id);

    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ reason: 'user_cancelled' }));
    expect(transition.mock.calls[0]?.[0]).not.toHaveProperty('notification');
  });

  it('отмена после срока пишет quote_expired, а не user_cancelled', async () => {
    const id = await awaiting();
    const transition = vi.spyOn(clockedRepository, 'transition');
    now = new Date(start.getTime() + 5 * 60_000);

    await clocked.cancelByUser('u1', id);

    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ reason: 'quote_expired' }));
    expect(transition.mock.calls[0]?.[0]).not.toHaveProperty('notification');
  });

  it('черновик без котировки закрывается по своему сроку и молча', async () => {
    const created = await clocked.createDraft({
      userId: 'u1',
      clientRequestId: 'r1',
      ...PAIR,
      fromAmount: '100',
      rateType: 'FLOATING',
      payoutAddress: 'test-payout-address',
    });
    const transition = vi.spyOn(clockedRepository, 'transition');
    now = new Date(start.getTime() + 30 * 60_000);

    await clocked.pollDueExchanges(10);

    expect(clockedRepository.rows.get(created.id)?.status).toBe('EXPIRED');
    expect(transition).toHaveBeenCalledWith(expect.objectContaining({ reason: 'draft_expired' }));
    expect(transition.mock.calls[0]?.[0]).not.toHaveProperty('notification');
  });

  it('ожидание депозита своими часами не закрывает', async () => {
    const id = await awaiting();
    await clocked.confirmAndCreate('u1', id);
    now = new Date(start.getTime() + 30 * 60_000);

    await clocked.pollDueExchanges(10);

    expect(clockedRepository.rows.get(id)?.status).toBe('WAITING_DEPOSIT');
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
