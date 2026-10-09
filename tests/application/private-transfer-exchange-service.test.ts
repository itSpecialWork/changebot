/**
 * Ветка ExchangeService для перевода одной монеты.
 * Другая сеть остаётся на ExchangeProvider. Без провайдера перевода пара недоступна.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { ExchangeService } from '../../src/application/exchanges/exchange-service.js';
import { ExchangeProviderError } from '../../src/domain/exchanges/exchange-provider.js';
import type { PrivateTransferProvider } from '../../src/domain/exchanges/private-transfer-provider.js';
import {
  DEFAULT_MOCK_CURRENCIES,
  DEFAULT_MOCK_RATES,
  MockExchangeProvider,
} from '../../src/integrations/mock/mock-exchange-provider.js';
import { MockPrivateTransferProvider } from '../../src/integrations/mock/mock-private-transfer-provider.js';
import { createLogger } from '../../src/observability/logger.js';
import { InMemoryExchangeRepository } from '../telegram/bot/harness.js';

const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });
const USDT_ETH = {
  ticker: 'usdt',
  network: 'eth',
  name: 'Tether (ERC20)',
  extraId: 'none' as const,
  supportsFixedRate: true,
  featured: false,
};

class CountingTransfer implements PrivateTransferProvider {
  estimateCalls = 0;
  createCalls = 0;
  statusCalls = 0;
  private readonly inner = new MockPrivateTransferProvider();

  estimate(
    request: Parameters<PrivateTransferProvider['estimate']>[0],
    options?: Parameters<PrivateTransferProvider['estimate']>[1],
  ): ReturnType<PrivateTransferProvider['estimate']> {
    this.estimateCalls += 1;
    return this.inner.estimate(request, options);
  }

  create(
    request: Parameters<PrivateTransferProvider['create']>[0],
    options?: Parameters<PrivateTransferProvider['create']>[1],
  ): ReturnType<PrivateTransferProvider['create']> {
    this.createCalls += 1;
    return this.inner.create(request, options);
  }

  getStatus(
    providerTransferId: string,
    options?: Parameters<PrivateTransferProvider['getStatus']>[1],
  ): ReturnType<PrivateTransferProvider['getStatus']> {
    this.statusCalls += 1;
    return this.inner.getStatus(providerTransferId, options);
  }

  advanceStatus(providerTransferId: string): void {
    this.inner.advanceStatus(providerTransferId);
  }
}

let repository: InMemoryExchangeRepository;
let provider: MockExchangeProvider;
let transfer: CountingTransfer;
let service: ExchangeService;

beforeEach(() => {
  repository = new InMemoryExchangeRepository();
  provider = new MockExchangeProvider({
    currencies: [...DEFAULT_MOCK_CURRENCIES, USDT_ETH],
    rates: { ...DEFAULT_MOCK_RATES, 'usdt:trx>usdt:eth': '0.99' },
  });
  transfer = new CountingTransfer();
  service = new ExchangeService({
    repository,
    provider,
    providerKind: 'MOCK',
    privateTransfer: transfer,
    logger,
  });
});

describe('список получения', () => {
  it('оставляет ту же монету, когда перевод включён', async () => {
    const destinations = await service.listDestinationCurrencies({
      ticker: 'usdt',
      network: 'trx',
    });

    expect(destinations.map((currency) => `${currency.ticker}:${currency.network}`)).toContain(
      'usdt:trx',
    );
  });

  it('убирает ту же монету, когда перевод выключен', async () => {
    const disabled = new ExchangeService({
      repository,
      provider,
      providerKind: 'MOCK',
      logger,
    });

    const destinations = await disabled.listDestinationCurrencies({
      ticker: 'usdt',
      network: 'trx',
    });

    expect(destinations.map((currency) => `${currency.ticker}:${currency.network}`)).not.toContain(
      'usdt:trx',
    );
    expect(destinations.map((currency) => `${currency.ticker}:${currency.network}`)).toContain(
      'usdt:eth',
    );
  });
});

describe('та же монета', () => {
  it('считает сумму отправки из суммы получения и создаёт перевод', async () => {
    const preview = await service.previewPrivateTransfer({
      currency: 'usdt',
      network: 'trx',
      toAmount: '100',
    });
    expect(preview.toAmount).toBe('100');
    expect(preview.fromAmount).toBe('101');
    expect(repository.rows.size).toBe(0);

    const draft = await service.createDraft({
      userId: 'u1',
      clientRequestId: 'same-asset',
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'usdt',
      toNetwork: 'trx',
      fromAmount: '100',
      toAmount: '100',
      rateType: 'FLOATING',
      payoutAddress: 'recipient-address',
    });
    expect(draft.rateType).toBe('FIXED');
    expect(draft.expectedToAmount).toBe('100');
    expect(draft.expectedFromAmount).toBe('101');

    const prepared = await service.prepareConfirmation('u1', draft.id);
    expect(prepared.status).toBe('AWAITING_CONFIRMATION');
    expect(prepared.providerRateId).toMatch(/^mock-transfer-rate-/);

    const created = await service.confirmAndCreate('u1', draft.id);
    expect(created.status).toBe('WAITING_DEPOSIT');
    expect(created.payinAddress).toMatch(/^mock-payin-address-/);
    expect(created.expectedToAmount).toBe('100');
    expect(transfer.createCalls).toBe(1);

    transfer.advanceStatus(created.providerExchangeId ?? '');
    const synced = await service.syncWithProvider(created.id);
    expect(synced.outcome).toBe('transitioned');
    expect(synced.exchange.status).toBe('CONFIRMING');
    expect(transfer.statusCalls).toBe(1);
  });

  it('повтор того же запроса возвращает уже созданный черновик', async () => {
    const input = {
      userId: 'u1',
      clientRequestId: 'same-asset',
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'usdt',
      toNetwork: 'trx',
      fromAmount: '100',
      toAmount: '100',
      rateType: 'FIXED' as const,
      payoutAddress: 'recipient-address',
    };

    const first = await service.createDraft(input);
    const second = await service.createDraft(input);

    expect(second.id).toBe(first.id);
    expect(repository.rows.size).toBe(1);
  });

  it('без провайдера перевода не создаёт черновик и не зовёт обмен', async () => {
    const disabled = new ExchangeService({
      repository,
      provider,
      providerKind: 'MOCK',
      logger,
    });

    await expect(
      disabled.createDraft({
        userId: 'u1',
        clientRequestId: 'same-asset',
        fromCurrency: 'usdt',
        fromNetwork: 'trx',
        toCurrency: 'usdt',
        toNetwork: 'trx',
        fromAmount: '100',
        toAmount: '100',
        rateType: 'FIXED',
        payoutAddress: 'recipient-address',
      }),
    ).rejects.toBeInstanceOf(ExchangeProviderError);
    expect(repository.rows.size).toBe(0);
  });
});

describe('другая сеть той же монеты', () => {
  it('идёт через обмен и не вызывает перевод', async () => {
    const quote = await service.previewQuote({
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'usdt',
      toNetwork: 'eth',
      fromAmount: '100',
      rateType: 'FLOATING',
    });

    expect(quote.toAmount).toBe('99');
    expect(transfer.estimateCalls).toBe(0);
    expect(
      service.isPrivateTransferSelection({
        fromCurrency: 'usdt',
        fromNetwork: 'trx',
        toCurrency: 'usdt',
        toNetwork: 'eth',
      }),
    ).toBe(false);
  });
});
