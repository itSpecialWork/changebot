/**
 * ChangeNOW Private Transfer без сети: тела ответов — выдержки из
 * docs/changeNow/ChangeNOW.postman_collection.json.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ExchangeProviderError,
  type ExchangeProviderErrorCode,
} from '../../../src/domain/exchanges/exchange-provider.js';
import type { CreatePrivateTransferRequest } from '../../../src/domain/exchanges/private-transfer-provider.js';
import {
  ChangeNowPrivateTransferProvider,
  type ChangeNowFetch,
} from '../../../src/integrations/changenow/change-now-private-transfer-provider.js';

const API_KEY = 'test-api-key';
const DIR = dirname(fileURLToPath(import.meta.url));
const RECIPIENT = '0xd0c9cab0a10a7fbb6f52a92c6120bdbb54372501';
const BAD_ADDRESS = 'bc1qz8tqex5fv4eh5534hqg5cf9v8wxz9ksxheqdwn';

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

function createHarness(respond: (url: string, init: RequestInit) => Response): {
  provider: ChangeNowPrivateTransferProvider;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchImpl: ChangeNowFetch = (url, init) => {
    calls.push({ url, init });
    return Promise.resolve(respond(url, init));
  };
  const provider = new ChangeNowPrivateTransferProvider({ apiKey: API_KEY, fetch: fetchImpl });
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

function transferRequest(
  overrides: Partial<CreatePrivateTransferRequest> = {},
): CreatePrivateTransferRequest {
  return {
    currency: 'eth',
    network: 'eth',
    toAmount: '10',
    address: RECIPIENT,
    extraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateId: 'test-rate-id',
    ...overrides,
  };
}

describe('ChangeNowPrivateTransferProvider', () => {
  it('оценивает перевод по сумме получения и не шлёт userId', async () => {
    const body = fixture('private-transfer-estimate.json');
    const source = JSON.parse(body) as { rateId: string };
    const { provider, calls } = createHarness((url) => {
      expect(url).toContain('/v2/private-transfer/estimated-amount?');
      expect(url).toContain('currency=eth');
      expect(url).toContain('network=eth');
      expect(url).toContain('toAmount=10');
      expect(url).not.toContain('userId');
      return jsonResponse(200, body);
    });

    const estimate = await provider.estimate({ currency: 'eth', network: 'eth', toAmount: '10' });

    expect(calls[0]?.init.method).toBe('GET');
    expect(header(calls[0]?.init ?? {}, 'x-changenow-api-key')).toBe(API_KEY);
    expect(calls[0]?.init.redirect).toBe('manual');
    expect(estimate).toEqual({
      fromAmount: '10.10113071',
      toAmount: '10',
      rateId: source.rateId,
      validUntil: new Date('2026-03-23T10:30:36.779Z'),
      warningMessage: null,
    });
  });

  it('сохраняет числовую сумму из JSON строкой, без Float', async () => {
    const { provider } = createHarness(() =>
      jsonResponse(
        200,
        '{"currency":"eth","network":"eth","fromAmount":10.10113071,"toAmount":10,"rateId":"rate-1","validUntil":"2026-03-23T10:30:36.779Z","warningMessage":null}',
      ),
    );

    const estimate = await provider.estimate({ currency: 'eth', network: 'eth', toAmount: '10' });

    expect(estimate.fromAmount).toBe('10.10113071');
    expect(estimate.toAmount).toBe('10');
  });

  it('создание шлёт rateId и не шлёт пустые необязательные поля', async () => {
    const { provider, calls } = createHarness(() =>
      jsonResponse(200, fixture('private-transfer-created.json')),
    );

    const created = await provider.create(transferRequest());

    const raw = calls[0]?.init.body;
    expect(typeof raw).toBe('string');
    if (typeof raw !== 'string') return;
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.url).toBe('https://api.changenow.io/v2/private-transfer');
    expect(raw).toContain('"toAmount":"10"');
    expect(raw).toContain('"rateId":"test-rate-id"');
    expect(raw).toContain(`"address":"${RECIPIENT}"`);
    expect(raw).not.toContain('userId');
    expect(raw).not.toContain('extraId');
    expect(raw).not.toContain('refundAddress');
    expect(created).toEqual({
      providerTransferId: '366e345a27d6a1',
      fromAmount: '10.10113071',
      toAmount: '10',
      payinAddress: '0x5a96bFF5F7E6822F0f81a7100F6D98A486ff6537',
      payoutAddress: RECIPIENT,
      payinExtraId: null,
      payoutExtraId: null,
    });
  });

  it('пустой rateId не уходит в сеть', async () => {
    const { provider, calls } = createHarness(() =>
      jsonResponse(200, fixture('private-transfer-created.json')),
    );

    await expectCode(provider.create(transferRequest({ rateId: '  ' })), 'INVALID_REQUEST');

    expect(calls).toHaveLength(0);
  });

  it('статус читается тем же by-id, что и обмен', async () => {
    const { provider, calls } = createHarness((url) => {
      expect(url).toContain('/v2/exchange/by-id?id=81cc9c3a9157a6');
      return jsonResponse(200, fixture('status-finished.json'));
    });

    const status = await provider.getStatus('81cc9c3a9157a6');

    expect(calls[0]?.init.method).toBe('GET');
    expect(status).toEqual({
      providerExchangeId: '81cc9c3a9157a6',
      providerStatus: 'finished',
      status: 'FINISHED',
      actualFromAmount: '0.013',
      actualToAmount: '7.41109355',
    });
  });

  it('неизвестный сырой статус становится VERIFYING', async () => {
    const body = fixture('status-finished.json').replace('"finished"', '"holding"');
    const { provider } = createHarness(() => jsonResponse(200, body));

    const status = await provider.getStatus('81cc9c3a9157a6');

    expect(status.providerStatus).toBe('holding');
    expect(status.status).toBe('VERIFYING');
  });

  it('401 становится временной недоступностью', async () => {
    const { provider } = createHarness(() =>
      jsonResponse(401, fixture('private-transfer-unauthorized.txt')),
    );

    const error = await expectCode(
      provider.estimate({ currency: 'eth', network: 'eth', toAmount: '10' }),
      'UNAVAILABLE',
    );

    expect(error.message).not.toContain(API_KEY);
  });

  it('неверный адрес становится INVALID_REQUEST и не копирует адрес', async () => {
    const { provider } = createHarness(() =>
      jsonResponse(400, fixture('private-transfer-bad-address.json')),
    );

    const error = await expectCode(provider.create(transferRequest()), 'INVALID_REQUEST');

    expect(error.message).not.toContain(BAD_ADDRESS);
  });

  it('редирект и обрыв сети не повторяют запрос с ключом', async () => {
    const redirected = createHarness(() => new Response(null, { status: 302 }));
    await expectCode(
      redirected.provider.estimate({ currency: 'eth', network: 'eth', toAmount: '10' }),
      'UNAVAILABLE',
    );
    expect(redirected.calls).toHaveLength(1);

    const broken: ChangeNowFetch = () => Promise.reject(new Error('socket hang up'));
    const provider = new ChangeNowPrivateTransferProvider({ apiKey: API_KEY, fetch: broken });
    await expectCode(
      provider.estimate({ currency: 'eth', network: 'eth', toAmount: '10' }),
      'UNAVAILABLE',
    );
  });

  it('прерванный сигнал и пустой id не уходят в сеть', async () => {
    const { provider, calls } = createHarness(() =>
      jsonResponse(200, fixture('status-finished.json')),
    );

    await expectCode(
      provider.getStatus('81cc9c3a9157a6', { signal: AbortSignal.abort() }),
      'UNAVAILABLE',
    );
    await expectCode(provider.getStatus('  '), 'INVALID_REQUEST');

    expect(calls).toHaveLength(0);
  });
});
