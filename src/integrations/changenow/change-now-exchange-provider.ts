/**
 * Адаптер ChangeNOW API v2.
 *
 * Реализует порт ExchangeProvider. Ключ передаётся в конструктор из конфигурации
 * и уходит только в заголовок x-changenow-api-key. Тело ответа, адреса и ключ
 * этот модуль не логирует. Редиректы не следуют, чтобы заголовок не ушёл на другой хост.
 */
import {
  InvalidDecimalError,
  formatDecimal,
  parseDecimal,
} from '../../domain/shared/decimal-string.js';
import {
  ExchangeProviderError,
  type AmountRangeRequest,
  type CreateExchangeRequest,
  type ExchangeProvider,
  type ExtraIdRequirement,
  type ProviderAmountRange,
  type ProviderCallOptions,
  type ProviderCurrency,
  type ProviderExchange,
  type ProviderExchangeStatus,
  type ProviderQuote,
  type QuoteRequest,
} from '../../domain/exchanges/exchange-provider.js';
import { parseJsonNumbersAsStrings } from './decimal-json.js';
import { mapChangeNowHttpError } from './map-http-error.js';
import { mapChangeNowStatus } from './map-status.js';
import {
  changeNowCreatedExchangeSchema,
  changeNowCurrencySchema,
  changeNowExchangeStatusSchema,
  changeNowQuoteSchema,
  changeNowRangeSchema,
  optionalText,
  type ChangeNowCurrency,
} from './schemas.js';

const DEFAULT_BASE_URL = 'https://api.changenow.io';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CURRENCY_CACHE_TTL_MS = 60_000;

export type ChangeNowFetch = (input: string, init: RequestInit) => Promise<Response>;

export interface ChangeNowExchangeProviderOptions {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly fetch?: ChangeNowFetch;
  /** 0 отключает кэш. В проде каталог держится минуту, чтобы поиск не дёргал API. */
  readonly currencyCacheTtlMs?: number;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
}

interface CurrencyCache {
  readonly at: number;
  readonly currencies: readonly ProviderCurrency[];
}

const defaultFetch: ChangeNowFetch = (input, init) => fetch(input, init);

export class ChangeNowExchangeProvider implements ExchangeProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: ChangeNowFetch;
  private readonly currencyCacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private currencyCache: CurrencyCache | undefined;

  constructor(options: ChangeNowExchangeProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? defaultFetch;
    this.currencyCacheTtlMs = options.currencyCacheTtlMs ?? DEFAULT_CURRENCY_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.now = options.now ?? (() => new Date());
  }

  async getCurrencies(options?: ProviderCallOptions): Promise<readonly ProviderCurrency[]> {
    const signal = this.signalFor(options);
    throwIfAborted(signal);
    const cached = this.readCurrencyCache();
    if (cached) return cached;

    const body = await this.request(
      'GET',
      '/v2/exchange/currencies?active=true',
      undefined,
      signal,
    );
    if (!Array.isArray(body)) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected currencies response');
    }

    const currencies: ProviderCurrency[] = [];
    for (const item of body) {
      const parsed = changeNowCurrencySchema.safeParse(item);
      if (!parsed.success || parsed.data.isFiat) continue;
      const currency = toCurrency(parsed.data);
      if (currency) currencies.push(currency);
    }
    if (currencies.length === 0) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Currency catalog is empty');
    }
    this.currencyCache = { at: this.now().getTime(), currencies };
    return currencies;
  }

  async getQuote(request: QuoteRequest, options?: ProviderCallOptions): Promise<ProviderQuote> {
    const signal = this.signalFor(options);
    const url = new URL('/v2/exchange/estimated-amount', this.baseUrl);
    const receive = request.direction === 'receive';
    url.searchParams.set('fromCurrency', request.fromCurrency);
    url.searchParams.set('toCurrency', request.toCurrency);
    url.searchParams.set('fromNetwork', request.fromNetwork);
    url.searchParams.set('toNetwork', request.toNetwork);
    url.searchParams.set(receive ? 'toAmount' : 'fromAmount', request.fromAmount);
    url.searchParams.set(
      'flow',
      receive || request.rateType === 'FIXED' ? 'fixed-rate' : 'standard',
    );
    url.searchParams.set('type', receive ? 'reverse' : 'direct');
    url.searchParams.set('useRateId', receive || request.rateType === 'FIXED' ? 'true' : 'false');

    const body = await this.request('GET', `${url.pathname}${url.search}`, undefined, signal);
    const parsed = changeNowQuoteSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected quote response');
    }

    const fromAmount = requireAmount(parsed.data.fromAmount);
    const toAmount = requireAmount(parsed.data.toAmount);
    if (parseDecimal(toAmount) === 0n) {
      throw new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is too small');
    }
    if (request.rateType === 'FLOATING') {
      return { rateType: 'FLOATING', fromAmount, toAmount, rateId: null, expiresAt: null };
    }

    const rateId = parsed.data.rateId?.trim() ?? '';
    const validUntil = parsed.data.validUntil?.trim() ?? '';
    if (rateId === '' || validUntil === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Fixed quote is missing rate id');
    }
    const expiresAt = new Date(validUntil);
    if (Number.isNaN(expiresAt.getTime())) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Provider quote expiry is invalid');
    }
    return { rateType: 'FIXED', fromAmount, toAmount, rateId, expiresAt };
  }

  async getAmountRange(
    request: AmountRangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderAmountRange> {
    const signal = this.signalFor(options);
    const url = new URL('/v2/exchange/range', this.baseUrl);
    url.searchParams.set('fromCurrency', request.fromCurrency);
    url.searchParams.set('toCurrency', request.toCurrency);
    url.searchParams.set('fromNetwork', request.fromNetwork);
    url.searchParams.set('toNetwork', request.toNetwork);
    url.searchParams.set('flow', request.rateType === 'FIXED' ? 'fixed-rate' : 'standard');

    const body = await this.request('GET', `${url.pathname}${url.search}`, undefined, signal);
    const parsed = changeNowRangeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected range response');
    }
    return {
      minAmount: requireAmount(parsed.data.minAmount),
      maxAmount: parsed.data.maxAmount === null ? null : requireAmount(parsed.data.maxAmount),
    };
  }

  async createExchange(
    request: CreateExchangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchange> {
    const signal = this.signalFor(options);
    const receive = request.direction === 'receive';
    const payload: Record<string, string> = {
      fromCurrency: request.fromCurrency,
      fromNetwork: request.fromNetwork,
      toCurrency: request.toCurrency,
      toNetwork: request.toNetwork,
      address: request.payoutAddress,
      flow: receive || request.rateType === 'FIXED' ? 'fixed-rate' : 'standard',
      type: receive ? 'reverse' : 'direct',
    };
    payload[receive ? 'toAmount' : 'fromAmount'] = request.fromAmount;
    if (request.payoutExtraId !== null) payload.extraId = request.payoutExtraId;
    if (request.refundAddress !== null) payload.refundAddress = request.refundAddress;
    if (request.refundExtraId !== null) payload.refundExtraId = request.refundExtraId;
    if (receive || request.rateType === 'FIXED') {
      if (request.rateId === null || request.rateId.trim() === '') {
        throw new ExchangeProviderError('INVALID_REQUEST', 'Fixed exchange requires rate id');
      }
      payload.rateId = request.rateId;
    }

    const body = await this.request('POST', '/v2/exchange', payload, signal);
    const parsed = changeNowCreatedExchangeSchema.safeParse(body);
    if (!parsed.success) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Unexpected create exchange response');
    }
    const created = parsed.data;
    return {
      providerExchangeId: created.id,
      payinAddress: created.payinAddress,
      payinExtraId: emptyToNull(created.payinExtraId),
      providerStatus: 'new',
      expectedFromAmount: requireAmount(created.fromAmount),
      expectedToAmount: requireAmount(created.toAmount),
    };
  }

  async getExchangeStatus(
    providerExchangeId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus> {
    const signal = this.signalFor(options);
    if (providerExchangeId.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Exchange id is required');
    }
    const url = new URL('/v2/exchange/by-id', this.baseUrl);
    url.searchParams.set('id', providerExchangeId);
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
      payinHash: optionalText(parsed.data.payinHash),
      payoutHash: optionalText(parsed.data.payoutHash),
      refundHash: optionalText(parsed.data.refundHash),
    };
  }

  private readCurrencyCache(): readonly ProviderCurrency[] | undefined {
    if (this.currencyCache === undefined || this.currencyCacheTtlMs <= 0) return undefined;
    const age = this.now().getTime() - this.currencyCache.at;
    if (age < 0 || age >= this.currencyCacheTtlMs) return undefined;
    return this.currencyCache.currencies;
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

function toCurrency(currency: ChangeNowCurrency): ProviderCurrency | undefined {
  const ticker = currency.ticker.trim().toLowerCase();
  const network = currency.network.trim().toLowerCase();
  const name = currency.name.trim();
  if (ticker === '' || network === '' || name === '') return undefined;
  return {
    ticker,
    network,
    name,
    extraId: mapExtraId(currency.isExtraIdSupported),
    supportsFixedRate: currency.supportsFixedRate,
    featured: currency.featured,
  };
}

/**
 * extraId в домене — про получение средств (payout).
 * isExtraIdSupported значит, что адрес получения может принять memo, но не обязан:
 * личный кошелёк вроде Exodus часто обходится без него.
 * hasExternalId к выплате не относится: это memo депозита, его выдаёт ChangeNOW.
 */
function mapExtraId(isExtraIdSupported: boolean): ExtraIdRequirement {
  return isExtraIdSupported ? 'optional' : 'none';
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
