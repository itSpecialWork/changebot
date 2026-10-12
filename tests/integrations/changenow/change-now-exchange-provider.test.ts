/**
 * ChangeNOW API v2 без сети: тела ответов — выдержки из
 * docs/changeNow/ChangeNOW.postman_collection.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ExchangeProviderError,
  type CreateExchangeRequest,
  type ExchangeProviderErrorCode,
  type QuoteRequest,
} from '../../../src/domain/exchanges/exchange-provider.js';
import {
  ChangeNowExchangeProvider,
  type ChangeNowFetch,
} from '../../../src/integrations/changenow/change-now-exchange-provider.js';

const API_KEY = 'test-api-key';
const DIR = dirname(fileURLToPath(import.meta.url));

const floatingQuote: QuoteRequest = {
  fromCurrency: 'btc',
  fromNetwork: 'btc',
  toCurrency: 'usdt',
  toNetwork: 'eth',
  fromAmount: '0.1',
  rateType: 'FLOATING',
};

function fixture(name: string): string {
  return readFileSync(join(DIR, 'fixtures', name), 'utf8');
}

function jsonResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

function createHarness(
  respond: (url: string, init: RequestInit) => Response,
  options: { readonly currencyCacheTtlMs?: number; readonly now?: () => Date } = {},
): { provider: ChangeNowExchangeProvider; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: ChangeNowFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  };
  const provider = new ChangeNowExchangeProvider({
    apiKey: API_KEY,
    fetch: fetchImpl,
    currencyCacheTtlMs: options.currencyCacheTtlMs ?? 0,
    ...(options.now ? { now: options.now } : {}),
  });
  return { provider, calls };
}

function header(init: RequestInit, name: string): string | undefined {
  const headers = init.headers;
  if (!headers || headers instanceof Headers || Array.isArray(headers)) return undefined;
  const value = headers[name];
  return typeof value === 'string' ? value : undefined;
}

async function expectCode(
  promise: Promise<unknown>,
  code: ExchangeProviderErrorCode,
): Promise<ExchangeProviderError> {
  const error: unknown = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(ExchangeProviderError);
  const providerError = error as ExchangeProviderError;
  expect(providerError.code).toBe(code);
  return providerError;
}

function exchangeRequest(overrides: Partial<CreateExchangeRequest> = {}): CreateExchangeRequest {
  return {
    ...floatingQuote,
    payoutAddress: '0x57f31ad4b64095347F87eDB1675566DAfF5EC886',
    payoutExtraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateId: null,
    ...overrides,
  };
}

describe('ChangeNowExchangeProvider', () => {
  it('запрашивает активные валюты и отбрасывает фиат', async () => {
    const { provider, calls } = createHarness(() => jsonResponse(200, fixture('currencies.json')));

    const currencies = await provider.getCurrencies();

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('/v2/exchange/currencies?active=true');
    expect(calls[0]?.init.method).toBe('GET');
    expect(header(calls[0]?.init ?? {}, 'x-changenow-api-key')).toBe(API_KEY);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(currencies).toEqual([
      {
        ticker: 'btc',
        network: 'btc',
        name: 'Bitcoin',
        extraId: 'none',
        supportsFixedRate: true,
        featured: true,
      },
      {
        ticker: 'usdt',
        network: 'algo',
        name: 'Tether (Algorand)',
        extraId: 'optional',
        supportsFixedRate: true,
        featured: false,
      },
      {
        ticker: 'usdt',
        network: 'ton',
        name: 'Tether USD (TON)',
        extraId: 'optional',
        supportsFixedRate: false,
        featured: false,
      },
    ]);
  });

  it('пропускает битую запись каталога и не роняет список', async () => {
    const list = JSON.parse(fixture('currencies.json')) as unknown[];
    list.push({ ticker: 1 });
    const { provider } = createHarness(() => jsonResponse(200, JSON.stringify(list)));

    const currencies = await provider.getCurrencies();

    expect(currencies.map((c) => c.ticker)).toEqual(['btc', 'usdt', 'usdt']);
  });

  it('кэширует каталог на время TTL', async () => {
    let now = new Date('2026-01-01T00:00:00.000Z');
    const { provider, calls } = createHarness(() => jsonResponse(200, fixture('currencies.json')), {
      currencyCacheTtlMs: 60_000,
      now: () => now,
    });

    await provider.getCurrencies();
    await provider.getCurrencies();
    expect(calls).toHaveLength(1);

    now = new Date(now.getTime() + 60_000);
    await provider.getCurrencies();
    expect(calls).toHaveLength(2);
  });

  it('плавающая котировка не тащит number и не задаёт срок', async () => {
    const { provider, calls } = createHarness((url) => {
      expect(url).toContain('flow=standard');
      expect(url).toContain('type=direct');
      expect(url).toContain('useRateId=false');
      expect(url).toContain('fromAmount=0.1');
      return jsonResponse(200, fixture('estimated-floating.json'));
    });

    const quote = await provider.getQuote(floatingQuote);

    expect(calls[0]?.init.method).toBe('GET');
    expect(quote).toEqual({
      rateType: 'FLOATING',
      fromAmount: '0.1',
      toAmount: '3419.576832',
      rateId: null,
      expiresAt: null,
    });
  });

  it('фиксированная котировка сохраняет rateId и срок из текста JSON', async () => {
    const { provider } = createHarness((url) => {
      expect(url).toContain('flow=fixed-rate');
      expect(url).toContain('useRateId=true');
      return jsonResponse(200, fixture('estimated-fixed.json'));
    });

    const quote = await provider.getQuote({ ...floatingQuote, rateType: 'FIXED' });

    expect(quote.rateId).toBe('Sd5UzPYKbys4miuq1vwYX9dowPkQipgt');
    expect(quote.toAmount).toBe('3434.835033');
    expect(quote.expiresAt?.toISOString()).toBe('2023-11-07T09:21:27.448Z');
  });

  it('диапазон суммы читает минимум строкой, пустой максимум — как null', async () => {
    const { provider, calls } = createHarness((url) => {
      expect(url).toContain('/v2/exchange/range?');
      expect(url).toContain('fromCurrency=btc');
      expect(url).toContain('fromNetwork=btc');
      expect(url).toContain('toCurrency=usdt');
      expect(url).toContain('toNetwork=eth');
      expect(url).toContain('flow=standard');
      return jsonResponse(200, fixture('range-standard.json'));
    });

    const range = await provider.getAmountRange({
      fromCurrency: floatingQuote.fromCurrency,
      fromNetwork: floatingQuote.fromNetwork,
      toCurrency: floatingQuote.toCurrency,
      toNetwork: floatingQuote.toNetwork,
      rateType: 'FLOATING',
    });

    expect(calls[0]?.init.method).toBe('GET');
    expect(header(calls[0]?.init ?? {}, 'x-changenow-api-key')).toBe(API_KEY);
    expect(range).toEqual({ minAmount: '0.0002625', maxAmount: null });
  });

  it('фиксированный диапазон запрашивает flow fixed-rate и оба предела', async () => {
    const { provider } = createHarness((url) => {
      expect(url).toContain('flow=fixed-rate');
      return jsonResponse(200, '{"minAmount":1.5,"maxAmount":10}');
    });

    const range = await provider.getAmountRange({
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      rateType: 'FIXED',
    });

    expect(range).toEqual({ minAmount: '1.5', maxAmount: '10' });
  });

  it('неподдерживаемая пара в диапазоне становится PAIR_NOT_SUPPORTED', async () => {
    const { provider } = createHarness(() =>
      jsonResponse(400, '{"error":"not_valid_params","message":"Currency t is not supported"}'),
    );

    await expectCode(
      provider.getAmountRange({
        fromCurrency: 'btc',
        fromNetwork: 'btc',
        toCurrency: 't',
        toNetwork: 'eth',
        rateType: 'FLOATING',
      }),
      'PAIR_NOT_SUPPORTED',
    );
  });

  it('фиксированная котировка без rateId отклоняется', async () => {
    const { provider } = createHarness(() => jsonResponse(200, fixture('estimated-floating.json')));

    await expectCode(provider.getQuote({ ...floatingQuote, rateType: 'FIXED' }), 'INVALID_REQUEST');
  });

  it('создание обмена отправляет сумму строкой и не шлёт пустой возврат', async () => {
    const { provider, calls } = createHarness(() =>
      jsonResponse(200, fixture('created-standard.json')),
    );

    const created = await provider.createExchange(exchangeRequest());

    const raw = calls[0]?.init.body;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.changenow.io/v2/exchange');
    expect(raw).toContain('"fromAmount":"0.1"');
    expect(raw).not.toContain('refundAddress');
    expect(raw).not.toContain('rateId');
    expect(created).toEqual({
      providerExchangeId: '3a2360771439a3',
      payinAddress: '3M7QKsJDKbVZAhFPpFSVtVQv6Nzon3Lwtv',
      payinExtraId: null,
      providerStatus: 'new',
      expectedFromAmount: '0.003',
      expectedToAmount: '0.052286',
    });
  });

  it('статус finished читает фактические суммы строками', async () => {
    const { provider, calls } = createHarness((url) => {
      expect(url).toContain('/v2/exchange/by-id?id=81cc9c3a9157a6');
      return jsonResponse(200, fixture('status-finished.json'));
    });

    const status = await provider.getExchangeStatus('81cc9c3a9157a6');

    expect(calls[0]?.init.method).toBe('GET');
    expect(status).toEqual({
      providerExchangeId: '81cc9c3a9157a6',
      providerStatus: 'finished',
      status: 'FINISHED',
      actualFromAmount: '0.013',
      actualToAmount: '7.41109355',
      payinHash: null,
      payoutHash: null,
      refundHash: null,
    });
  });

  it('читает хэши транзакций и пустую строку считает отсутствием', async () => {
    const body = fixture('status-finished.json').replace(
      '"refundExtraId": null',
      '"refundExtraId": null, "payinHash": " 00aa", "payoutHash": "", "refundHash": null',
    );
    const { provider } = createHarness(() => jsonResponse(200, body));

    const status = await provider.getExchangeStatus('81cc9c3a9157a6');

    expect(status.payinHash).toBe('00aa');
    expect(status.payoutHash).toBeNull();
    expect(status.refundHash).toBeNull();
  });

  it('неизвестный сырой статус становится VERIFYING', async () => {
    const body = fixture('status-finished.json').replace('"finished"', '"holding"');
    const { provider } = createHarness(() => jsonResponse(200, body));

    const status = await provider.getExchangeStatus('81cc9c3a9157a6');

    expect(status.providerStatus).toBe('holding');
    expect(status.status).toBe('VERIFYING');
  });

  it('new остаётся ожиданием депозита', async () => {
    const body = fixture('status-finished.json').replace('"finished"', '"new"');
    const { provider } = createHarness(() => jsonResponse(200, body));

    const status = await provider.getExchangeStatus('81cc9c3a9157a6');

    expect(status.status).toBe('WAITING_DEPOSIT');
  });

  it.each([
    ['error-out-of-range.json', 'AMOUNT_OUT_OF_RANGE', '0.002644'],
    ['error-not-supported.json', 'PAIR_NOT_SUPPORTED', 'Currency t'],
    ['error-rate-expired.json', 'QUOTE_EXPIRED', 'puLHO5Y2EPg05QkN11OnbRxCA3wCGtBr'],
    ['error-bad-address.json', 'INVALID_REQUEST', '0x57f31ad4b64095347F87eDB1675566DAfF5EC'],
  ] as const)('%s → %s и не копирует сырой текст', async (file, code, secret) => {
    const { provider } = createHarness(() => jsonResponse(400, fixture(file)));

    const error = await expectCode(provider.getQuote(floatingQuote), code);

    expect(error.message).not.toContain(secret);
  });

  it('401 и обрыв сети — временная недоступность', async () => {
    const unauthorized = createHarness(() => jsonResponse(401, 'Unauthorized'));
    await expectCode(unauthorized.provider.getCurrencies(), 'UNAVAILABLE');

    const broken: ChangeNowFetch = () => Promise.reject(new Error('socket hang up'));
    const provider = new ChangeNowExchangeProvider({
      apiKey: API_KEY,
      fetch: broken,
      currencyCacheTtlMs: 0,
    });
    await expectCode(provider.getCurrencies(), 'UNAVAILABLE');
  });

  it('прерванный сигнал не уходит в сеть', async () => {
    const { provider, calls } = createHarness(() => jsonResponse(200, fixture('currencies.json')));

    await expectCode(provider.getCurrencies({ signal: AbortSignal.abort() }), 'UNAVAILABLE');

    expect(calls).toHaveLength(0);
  });
});
