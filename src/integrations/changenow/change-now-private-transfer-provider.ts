/**
 * Адаптер ChangeNOW Private Transfer.
 *
 * Тот же ключ и тот же разбор ошибок, что у обмена. Ключ уходит только в заголовок
 * x-changenow-api-key. Тело ответа, адреса, rateId и ключ этот модуль не логирует.
 * Редиректы не следуют, чтобы заголовок не ушёл на другой хост.
 * Статус читается тем же GET /v2/exchange/by-id, что и статус обмена.
 */
import {
  InvalidDecimalError,
  formatDecimal,
  parseDecimal,
} from '../../domain/shared/decimal-string.js';
import {
  ExchangeProviderError,
  type ProviderCallOptions,
  type ProviderExchangeStatus,
} from '../../domain/exchanges/exchange-provider.js';
import type {
  CreatePrivateTransferRequest,
  PrivateTransfer,
  PrivateTransferEstimate,
  PrivateTransferEstimateRequest,
  PrivateTransferProvider,
} from '../../domain/exchanges/private-transfer-provider.js';
import { parseJsonNumbersAsStrings } from './decimal-json.js';
import { mapChangeNowHttpError } from './map-http-error.js';
import { mapChangeNowStatus } from './map-status.js';
import {
  changeNowExchangeStatusSchema,
  changeNowPrivateTransferCreatedSchema,
  changeNowPrivateTransferEstimateSchema,
} from './schemas.js';

const DEFAULT_BASE_URL = 'https://api.changenow.io';
const DEFAULT_TIMEOUT_MS = 10_000;

export type ChangeNowFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ChangeNowPrivateTransferProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: ChangeNowFetch;
  readonly timeoutMs?: number;
}

const defaultFetch: ChangeNowFetch = (input, init) => fetch(input, init);

export class ChangeNowPrivateTransferProvider implements PrivateTransferProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: ChangeNowFetch;
  private readonly timeoutMs: number;

  constructor(options: ChangeNowPrivateTransferProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async estimate(
    request: PrivateTransferEstimateRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransferEstimate> {
    const signal = this.signalFor(options);
    const url = new URL('/v2/private-transfer/estimated-amount', this.baseUrl);
    url.searchParams.set('currency', request.currency);
    url.searchParams.set('network', request.network);
    url.searchParams.set('toAmount', request.toAmount);

    const body = await this.request('GET', `${url.pathname}${url.search}`, undefined, signal);
    const parsed = changeNowPrivateTransferEstimateSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected private transfer quote response');
    }
    assertSameAsset(request.currency, request.network, parsed.data.currency, parsed.data.network);

    const rateId = parsed.data.rateId.trim();
    const validUntilRaw = parsed.data.validUntil.trim();
    if (rateId === '' || validUntilRaw === '') {
      throw new ExchangeProviderError(
        'INVALID_REQUEST',
        'Private transfer quote is missing rate id',
      );
    }
    const validUntil = new Date(validUntilRaw);
    if (Number.isNaN(validUntil.getTime())) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider quote expiry is invalid');
    }

    return {
      fromAmount: requireAmount(parsed.data.fromAmount),
      toAmount: requireAmount(parsed.data.toAmount),
      rateId,
      validUntil,
      warningMessage: emptyToNull(parsed.data.warningMessage),
    };
  }

  async create(
    request: CreatePrivateTransferRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransfer> {
    const signal = this.signalFor(options);
    if (request.rateId.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Private transfer requires rate id');
    }

    const payload: Record<string, string> = {
      currency: request.currency,
      network: request.network,
      toAmount: request.toAmount,
      address: request.address,
      rateId: request.rateId,
    };
    const extraId = emptyToNull(request.extraId);
    const refundAddress = emptyToNull(request.refundAddress);
    const refundExtraId = emptyToNull(request.refundExtraId);
    if (extraId !== null) payload.extraId = extraId;
    if (refundAddress !== null) payload.refundAddress = refundAddress;
    if (refundExtraId !== null) payload.refundExtraId = refundExtraId;

    const body = await this.request('POST', '/v2/private-transfer', payload, signal);
    const parsed = changeNowPrivateTransferCreatedSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected private transfer response');
    }
    assertSameAsset(request.currency, request.network, parsed.data.currency, parsed.data.network);

    return {
      providerTransferId: parsed.data.id,
      fromAmount: requireAmount(parsed.data.fromAmount),
      toAmount: requireAmount(parsed.data.toAmount),
      payinAddress: parsed.data.payinAddress,
      payoutAddress: parsed.data.payoutAddress,
      payinExtraId: emptyToNull(parsed.data.payinExtraId),
      payoutExtraId: emptyToNull(parsed.data.payoutExtraId),
      // Ответ создания статуса не содержит. new — тот же начальный статус, что у обмена.
      providerStatus: 'new',
    };
  }

  async getStatus(
    providerTransferId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus> {
    const signal = this.signalFor(options);
    if (providerTransferId.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Transfer id is required');
    }
    const url = new URL('/v2/exchange/by-id', this.baseUrl);
    url.searchParams.set('id', providerTransferId);
    const body = await this.request('GET', `${url.pathname}${url.search}`, undefined, signal);
    const parsed = changeNowExchangeStatusSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected exchange status response');
    }
    return {
      providerExchangeId: parsed.data.id,
      providerStatus: parsed.data.status,
      status: mapChangeNowStatus(parsed.data.status),
      actualFromAmount: optionalAmount(parsed.data.amountFrom),
      actualToAmount: optionalAmount(parsed.data.amountTo),
    };
  }

  private signalFor(options?: ProviderCallOptions): AbortSignal {
    return options?.signal ?? AbortSignal.timeout(this.timeoutMs);
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    payload: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    throwIfAborted(signal);
    const headers: Record<string, string> = {
      accept: 'application/json',
      'x-changenow-api-key': this.apiKey,
    };
    if (payload !== undefined) headers['content-type'] = 'application/json';

    const init: RequestInit = { method, headers, signal, redirect: 'manual' };
    if (payload !== undefined) init.body = JSON.stringify(payload);

    let response: Response;
    let text: string;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
      text = await response.text();
    } catch {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider request failed');
    }

    if (response.status >= 300 && response.status < 400) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider is unavailable');
    }
    if (!response.ok) throw mapChangeNowHttpError(response.status, text);

    try {
      return parseJsonNumbersAsStrings(text);
    } catch {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider response is not JSON');
    }
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new ExchangeProviderError('UNAVAILABLE', 'Provider call was aborted');
  }
}

function assertSameAsset(
  requestCurrency: string,
  requestNetwork: string,
  responseCurrency: string,
  responseNetwork: string,
): void {
  const currency = responseCurrency.trim().toLowerCase();
  const network = responseNetwork.trim().toLowerCase();
  if (
    currency === '' ||
    network === '' ||
    currency !== requestCurrency.trim().toLowerCase() ||
    network !== requestNetwork.trim().toLowerCase()
  ) {
    throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected private transfer asset');
  }
}

function requireAmount(value: string): string {
  try {
    return formatDecimal(parseDecimal(value));
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider amount is not a valid decimal');
    }
    throw error;
  }
}

function optionalAmount(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value.trim() === '') return null;
  return requireAmount(value);
}

function emptyToNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}
