import { beforeEach, describe, expect, it } from 'vitest';
import {
  ExchangeProviderError,
  type ExchangeProviderErrorCode,
} from '../../src/domain/exchanges/exchange-provider.js';
import type {
  CreatePrivateTransferRequest,
  PrivateTransferEstimateRequest,
} from '../../src/domain/exchanges/private-transfer-provider.js';
import { MockPrivateTransferProvider } from '../../src/integrations/mock/mock-private-transfer-provider.js';

const START = new Date('2026-01-01T00:00:00.000Z');

const tenEth: PrivateTransferEstimateRequest = {
  currency: 'eth',
  network: 'eth',
  toAmount: '10',
};

function transferRequest(
  rateId: string,
  overrides: Partial<CreatePrivateTransferRequest> = {},
): CreatePrivateTransferRequest {
  return {
    ...tenEth,
    address: 'test-recipient',
    extraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateId,
    ...overrides,
  };
}

async function expectProviderError(
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

describe('MockPrivateTransferProvider', () => {
  let now: Date;
  let provider: MockPrivateTransferProvider;

  beforeEach(() => {
    now = START;
    provider = new MockPrivateTransferProvider({ now: () => now });
  });

  it('считает сумму отправки из суммы получения, без Float', async () => {
    const estimate = await provider.estimate({ ...tenEth, toAmount: '0.1' });

    expect(estimate.fromAmount).toBe('0.101');
    expect(estimate.toAmount).toBe('0.1');
    expect(estimate.rateId).toBe('mock-transfer-rate-1');
    expect(estimate.validUntil).toEqual(new Date(START.getTime() + 120_000));
    expect(estimate.warningMessage).toBeNull();
  });

  it('неизвестная валюта не поддерживается', async () => {
    await expectProviderError(
      provider.estimate({ currency: 'doge', network: 'doge', toAmount: '10' }),
      'PAIR_NOT_SUPPORTED',
    );
  });

  it('создаёт перевод только с живым rateId той же монеты и суммы', async () => {
    const estimate = await provider.estimate(tenEth);
    const created = await provider.create(transferRequest(estimate.rateId, { toAmount: '10.0' }));

    expect(created.fromAmount).toBe('10.1');
    expect(created.toAmount).toBe('10');
    expect(created.payinAddress).toBe('mock-payin-address-2');
    expect(created.payoutAddress).toBe('test-recipient');
    expect(created.payinExtraId).toBeNull();
    expect(created.providerStatus).toBe('waiting');

    await expectProviderError(provider.create(transferRequest('missing-rate')), 'INVALID_REQUEST');
    await expectProviderError(
      provider.create(transferRequest(estimate.rateId, { toAmount: '11' })),
      'INVALID_REQUEST',
    );

    now = new Date(estimate.validUntil.getTime());
    await expectProviderError(provider.create(transferRequest(estimate.rateId)), 'QUOTE_EXPIRED');
  });

  it('двигает статус и помечает неизвестный сырой статус как VERIFYING', async () => {
    const estimate = await provider.estimate(tenEth);
    const created = await provider.create(transferRequest(estimate.rateId));

    const waiting = await provider.getStatus(created.providerTransferId);
    expect(waiting).toMatchObject({
      providerStatus: 'waiting',
      status: 'WAITING_DEPOSIT',
      actualFromAmount: null,
      actualToAmount: null,
    });

    provider.advanceStatus(created.providerTransferId);
    const confirming = await provider.getStatus(created.providerTransferId);
    expect(confirming.status).toBe('CONFIRMING');

    provider.setProviderStatus(created.providerTransferId, 'holding');
    const unknown = await provider.getStatus(created.providerTransferId);
    expect(unknown.providerStatus).toBe('holding');
    expect(unknown.status).toBe('VERIFYING');

    await expectProviderError(provider.getStatus('missing'), 'NOT_FOUND');
  });

  it('прерванный сигнал не создаёт перевод', async () => {
    await expectProviderError(
      provider.estimate(tenEth, { signal: AbortSignal.abort() }),
      'UNAVAILABLE',
    );
    await expectProviderError(provider.getStatus('missing'), 'NOT_FOUND');
  });
});
