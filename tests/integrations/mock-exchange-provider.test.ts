import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExchangeProviderError,
  type CreateExchangeRequest,
  type ExchangeProviderErrorCode,
  type QuoteRequest,
} from '../../src/domain/exchanges/exchange-provider.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';

const START = new Date('2026-01-01T00:00:00.000Z');

const usdtToBtc: QuoteRequest = {
  fromCurrency: 'usdt',
  fromNetwork: 'trx',
  toCurrency: 'btc',
  toNetwork: 'btc',
  fromAmount: '100',
  rateType: 'FLOATING',
};

function exchangeRequest(overrides: Partial<CreateExchangeRequest> = {}): CreateExchangeRequest {
  return {
    ...usdtToBtc,
    payoutAddress: 'test-payout-address',
    payoutExtraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateId: null,
    ...overrides,
  };
}

async function expectProviderError(
  promise: Promise<unknown>,
  code: ExchangeProviderErrorCode,
): Promise<ExchangeProviderError> {
  const error: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(ExchangeProviderError);
  const providerError = error as ExchangeProviderError;
  expect(providerError.code).toBe(code);
  return providerError;
}

describe('MockExchangeProvider', () => {
  let now: Date;
  let provider: MockExchangeProvider;

  beforeEach(() => {
    now = START;
    provider = new MockExchangeProvider({ now: () => now });
  });

  describe('getCurrencies', () => {
    it('возвращает валюты вместе с сетями', async () => {
      const currencies = await provider.getCurrencies();
      expect(currencies).toContainEqual(
        expect.objectContaining({ ticker: 'usdt', network: 'trx', extraId: 'none' }),
      );
      expect(currencies).toContainEqual(
        expect.objectContaining({ ticker: 'xrp', network: 'xrp', extraId: 'required' }),
      );
    });

    it('возвращает копии: внешний код не меняет состояние мока', async () => {
      const first = await provider.getCurrencies();
      (first[0] as { name: string }).name = 'tampered';
      const second = await provider.getCurrencies();
      expect(second[0]?.name).not.toBe('tampered');
    });
  });

  describe('getQuote', () => {
    it('считает floating-котировку точно, без Float', async () => {
      const quote = await provider.getQuote({ ...usdtToBtc, fromAmount: '100.5' });
      expect(quote).toEqual({
        rateType: 'FLOATING',
        fromAmount: '100.5',
        toAmount: '0.001608',
        rateId: null,
        expiresAt: null,
      });
    });

    it('выдаёт fixed-котировку с rateId и сроком действия', async () => {
      const quote = await provider.getQuote({ ...usdtToBtc, rateType: 'FIXED' });
      expect(quote.rateId).toBe('mock-rate-1');
      expect(quote.expiresAt).toEqual(new Date(START.getTime() + 60_000));
    });

    it('различает одну валюту в разных сетях', async () => {
      await expectProviderError(
        provider.getQuote({ ...usdtToBtc, fromNetwork: 'eth' }),
        'PAIR_NOT_SUPPORTED',
      );
    });

    it('отклоняет неподдерживаемую пару и fixed без поддержки', async () => {
      await expectProviderError(
        provider.getQuote({ ...usdtToBtc, toCurrency: 'eth', toNetwork: 'eth' }),
        'PAIR_NOT_SUPPORTED',
      );
      await expectProviderError(
        provider.getQuote({
          ...usdtToBtc,
          toCurrency: 'xrp',
          toNetwork: 'xrp',
          rateType: 'FIXED',
        }),
        'PAIR_NOT_SUPPORTED',
      );
    });

    it.each(['abc', '-5', '1e3', ''])('отклоняет некорректную сумму %j', async (fromAmount) => {
      await expectProviderError(provider.getQuote({ ...usdtToBtc, fromAmount }), 'INVALID_REQUEST');
    });

    it('проверяет лимиты суммы', async () => {
      await expectProviderError(
        provider.getQuote({ ...usdtToBtc, fromAmount: '0.00001' }),
        'AMOUNT_OUT_OF_RANGE',
      );
      await expectProviderError(
        provider.getQuote({ ...usdtToBtc, fromAmount: '1000001' }),
        'AMOUNT_OUT_OF_RANGE',
      );
    });

    it('прерывается по AbortSignal как временная ошибка', async () => {
      const controller = new AbortController();
      controller.abort();
      const error = await expectProviderError(
        provider.getQuote(usdtToBtc, { signal: controller.signal }),
        'UNAVAILABLE',
      );
      expect(error.retryable).toBe(true);
    });
  });

  describe('createExchange', () => {
    it('создаёт floating-обмен в статусе waiting', async () => {
      const exchange = await provider.createExchange(exchangeRequest());
      expect(exchange).toMatchObject({
        providerExchangeId: 'mock-exchange-1',
        providerStatus: 'waiting',
        expectedFromAmount: '100',
        expectedToAmount: '0.0016',
        payinExtraId: null,
      });
      expect(exchange.payinAddress).not.toBe('');
    });

    it('создаёт fixed-обмен по зафиксированному курсу', async () => {
      const quote = await provider.getQuote({ ...usdtToBtc, rateType: 'FIXED' });
      const exchange = await provider.createExchange(
        exchangeRequest({ rateType: 'FIXED', rateId: quote.rateId }),
      );
      expect(exchange.expectedToAmount).toBe(quote.toAmount);
    });

    it('отклоняет fixed-обмен с истёкшей котировкой', async () => {
      const quote = await provider.getQuote({ ...usdtToBtc, rateType: 'FIXED' });
      now = new Date(START.getTime() + 60_000);
      await expectProviderError(
        provider.createExchange(exchangeRequest({ rateType: 'FIXED', rateId: quote.rateId })),
        'QUOTE_EXPIRED',
      );
    });

    it('отклоняет fixed без rateId, с чужим rateId и с изменённой суммой', async () => {
      const quote = await provider.getQuote({ ...usdtToBtc, rateType: 'FIXED' });
      await expectProviderError(
        provider.createExchange(exchangeRequest({ rateType: 'FIXED', rateId: null })),
        'INVALID_REQUEST',
      );
      await expectProviderError(
        provider.createExchange(exchangeRequest({ rateType: 'FIXED', rateId: 'unknown' })),
        'INVALID_REQUEST',
      );
      await expectProviderError(
        provider.createExchange(
          exchangeRequest({ rateType: 'FIXED', rateId: quote.rateId, fromAmount: '200' }),
        ),
        'INVALID_REQUEST',
      );
    });

    it('отклоняет rateId для floating', async () => {
      await expectProviderError(
        provider.createExchange(exchangeRequest({ rateId: 'mock-rate-1' })),
        'INVALID_REQUEST',
      );
    });

    it('требует extraId там, где он обязателен, и запрещает там, где не поддерживается', async () => {
      const toXrp = { toCurrency: 'xrp', toNetwork: 'xrp' } as const;
      await expectProviderError(
        provider.createExchange(exchangeRequest({ ...toXrp, payoutExtraId: null })),
        'INVALID_REQUEST',
      );
      const exchange = await provider.createExchange(
        exchangeRequest({ ...toXrp, payoutExtraId: '0012345' }),
      );
      expect(exchange.providerExchangeId).toBeTruthy();

      await expectProviderError(
        provider.createExchange(exchangeRequest({ payoutExtraId: '123' })),
        'INVALID_REQUEST',
      );
    });

    it('требует адрес получения и не принимает refund extraId без refund адреса', async () => {
      await expectProviderError(
        provider.createExchange(exchangeRequest({ payoutAddress: '  ' })),
        'INVALID_REQUEST',
      );
      await expectProviderError(
        provider.createExchange(exchangeRequest({ refundExtraId: '1' })),
        'INVALID_REQUEST',
      );
    });

    it('выдаёт payin extraId, если валюта отправки его использует', async () => {
      provider = new MockExchangeProvider({
        now: () => now,
        rates: { 'xrp:xrp>btc:btc': '0.00001' },
      });
      const exchange = await provider.createExchange(
        exchangeRequest({
          fromCurrency: 'xrp',
          fromNetwork: 'xrp',
          toCurrency: 'btc',
          toNetwork: 'btc',
        }),
      );
      expect(exchange.payinExtraId).toMatch(/^mock-payin-memo-/);
    });

    it('даёт разным обменам разные идентификаторы и адреса', async () => {
      const first = await provider.createExchange(exchangeRequest());
      const second = await provider.createExchange(exchangeRequest());
      expect(second.providerExchangeId).not.toBe(first.providerExchangeId);
      expect(second.payinAddress).not.toBe(first.payinAddress);
    });
  });

  describe('getExchangeStatus', () => {
    it('проходит основную цепочку до finished и возвращает фактические суммы', async () => {
      const { providerExchangeId } = await provider.createExchange(exchangeRequest());

      const seen: string[] = [];
      for (let i = 0; i < 4; i += 1) {
        const status = await provider.getExchangeStatus(providerExchangeId);
        seen.push(status.status);
        expect(status.actualFromAmount).toBeNull();
        provider.advanceStatus(providerExchangeId);
      }
      expect(seen).toEqual(['WAITING_DEPOSIT', 'CONFIRMING', 'EXCHANGING', 'SENDING']);

      const finished = await provider.getExchangeStatus(providerExchangeId);
      expect(finished).toEqual({
        providerExchangeId,
        providerStatus: 'finished',
        status: 'FINISHED',
        actualFromAmount: '100',
        actualToAmount: '0.0016',
      });
    });

    it('не двигает обмен дальше finished', async () => {
      const { providerExchangeId } = await provider.createExchange(exchangeRequest());
      provider.setProviderStatus(providerExchangeId, 'finished');
      expect(() => {
        provider.advanceStatus(providerExchangeId);
      }).toThrow();
    });

    it.each([
      ['failed', 'FAILED'],
      ['refunded', 'REFUNDED'],
      ['verifying', 'VERIFYING'],
    ])('сопоставляет сырой статус %s с %s', async (raw, internal) => {
      const { providerExchangeId } = await provider.createExchange(exchangeRequest());
      provider.setProviderStatus(providerExchangeId, raw);
      const status = await provider.getExchangeStatus(providerExchangeId);
      expect(status.status).toBe(internal);
      expect(status.providerStatus).toBe(raw);
      expect(status.actualToAmount).toBeNull();
    });

    it('неизвестный сырой статус отправляет на проверку, а не теряет', async () => {
      const { providerExchangeId } = await provider.createExchange(exchangeRequest());
      provider.setProviderStatus(providerExchangeId, 'something-new');
      const status = await provider.getExchangeStatus(providerExchangeId);
      expect(status.status).toBe('VERIFYING');
      expect(status.providerStatus).toBe('something-new');
    });

    it('возвращает NOT_FOUND для неизвестного обмена и не считает её временной', async () => {
      const error = await expectProviderError(provider.getExchangeStatus('nope'), 'NOT_FOUND');
      expect(error.retryable).toBe(false);
    });
  });
});
