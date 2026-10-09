/**
 * MockExchangeProvider: детерминированный провайдер в памяти для разработки и тестов.
 *
 * Не обращается к сети, не использует реальные ключи и адреса. Все курсы,
 * лимиты и валюты по умолчанию вымышленные. Состояние живёт только в памяти процесса.
 *
 * Статусами обмена управляют тесты: `advanceStatus` двигает обмен по основной цепочке,
 * `setProviderStatus` задаёт любой статус (в том числе failed, refunded, verifying
 * и неизвестный сырой статус).
 */
import { randomUUID } from 'node:crypto';
import {
  compareDecimal,
  formatDecimal,
  multiplyDecimal,
  parseDecimal,
} from '../../domain/shared/decimal-string.js';
import {
  ExchangeProviderError,
  type AmountRangeRequest,
  type CreateExchangeRequest,
  type CurrencyPair,
  type ExchangeProvider,
  type ProviderAmountRange,
  type ProviderCallOptions,
  type ProviderCurrency,
  type ProviderExchange,
  type ProviderExchangeStatus,
  type ProviderExchangeStatusName,
  type ProviderQuote,
  type QuoteRequest,
} from '../../domain/exchanges/exchange-provider.js';

/** Сырые статусы мока (по форме близки к статусам реальных провайдеров). */
const RAW_STATUS_TO_INTERNAL: Readonly<Record<string, ProviderExchangeStatusName>> = {
  waiting: 'WAITING_DEPOSIT',
  confirming: 'CONFIRMING',
  exchanging: 'EXCHANGING',
  sending: 'SENDING',
  verifying: 'VERIFYING',
  finished: 'FINISHED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
};

const HAPPY_PATH = ['waiting', 'confirming', 'exchanging', 'sending', 'finished'] as const;

export const DEFAULT_MOCK_CURRENCIES: readonly ProviderCurrency[] = [
  {
    ticker: 'btc',
    network: 'btc',
    name: 'Bitcoin',
    extraId: 'none',
    supportsFixedRate: true,
    featured: true,
  },
  {
    ticker: 'eth',
    network: 'eth',
    name: 'Ethereum',
    extraId: 'none',
    supportsFixedRate: true,
    featured: true,
  },
  {
    ticker: 'usdt',
    network: 'trx',
    name: 'Tether (TRC20)',
    extraId: 'none',
    supportsFixedRate: true,
    featured: true,
  },
  {
    ticker: 'xrp',
    network: 'xrp',
    name: 'XRP',
    extraId: 'required',
    supportsFixedRate: false,
    featured: true,
  },
  {
    ticker: 'xlm',
    network: 'xlm',
    name: 'Stellar',
    extraId: 'optional',
    supportsFixedRate: true,
    featured: false,
  },
];

/** Вымышленные курсы: ключ — `from:fromNetwork>to:toNetwork`, значение — сколько to за 1 from. */
export const DEFAULT_MOCK_RATES: Readonly<Record<string, string>> = {
  'usdt:trx>btc:btc': '0.000016',
  'btc:btc>usdt:trx': '60000',
  'eth:eth>btc:btc': '0.05',
  'usdt:trx>xrp:xrp': '2',
  'usdt:trx>xlm:xlm': '10',
};

export interface MockExchangeProviderOptions {
  readonly currencies?: readonly ProviderCurrency[];
  readonly rates?: Readonly<Record<string, string>>;
  readonly minFromAmount?: string;
  readonly maxFromAmount?: string;
  /** Срок жизни зафиксированного курса (FIXED), мс. */
  readonly fixedQuoteTtlMs?: number;
  /** Источник времени; в тестах подставляется управляемые часы. */
  readonly now?: () => Date;
}

interface StoredQuote {
  readonly request: QuoteRequest;
  readonly toAmount: string;
  readonly expiresAt: Date;
}

interface StoredExchange {
  readonly expectedFromAmount: string;
  readonly expectedToAmount: string;
  readonly payinAddress: string;
  readonly payinExtraId: string | null;
  providerStatus: string;
  actualFromAmount: string | null;
  actualToAmount: string | null;
}

function pairKey(pair: CurrencyPair): string {
  return `${pair.fromCurrency}:${pair.fromNetwork}>${pair.toCurrency}:${pair.toNetwork}`;
}

function throwIfAborted(options?: ProviderCallOptions): void {
  if (options?.signal?.aborted) {
    throw new ExchangeProviderError('UNAVAILABLE', 'Provider call was aborted');
  }
}

export class MockExchangeProvider implements ExchangeProvider {
  private readonly currencies: readonly ProviderCurrency[];
  private readonly rates: Readonly<Record<string, string>>;
  private readonly minFromAmount: string;
  private readonly maxFromAmount: string;
  private readonly fixedQuoteTtlMs: number;
  private readonly now: () => Date;

  private readonly quotes = new Map<string, StoredQuote>();
  private readonly exchanges = new Map<string, StoredExchange>();
  private sequence = 0;

  constructor(options: MockExchangeProviderOptions = {}) {
    this.currencies = options.currencies ?? DEFAULT_MOCK_CURRENCIES;
    this.rates = options.rates ?? DEFAULT_MOCK_RATES;
    this.minFromAmount = options.minFromAmount ?? '0.0001';
    this.maxFromAmount = options.maxFromAmount ?? '1000000';
    this.fixedQuoteTtlMs = options.fixedQuoteTtlMs ?? 60_000;
    this.now = options.now ?? (() => new Date());
  }

  getCurrencies(options?: ProviderCallOptions): Promise<readonly ProviderCurrency[]> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.currencies.map((currency) => ({ ...currency }));
    });
  }

  getQuote(request: QuoteRequest, options?: ProviderCallOptions): Promise<ProviderQuote> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.buildQuote(request);
    });
  }

  getAmountRange(
    request: AmountRangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderAmountRange> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      this.requirePair(request);
      return { minAmount: this.minFromAmount, maxAmount: this.maxFromAmount };
    });
  }

  createExchange(
    request: CreateExchangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchange> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.openExchange(request);
    });
  }

  getExchangeStatus(
    providerExchangeId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus> {
    return Promise.resolve().then(() => {
      throwIfAborted(options);
      return this.toStatus(providerExchangeId, this.requireExchange(providerExchangeId));
    });
  }

  // --- Управление состоянием для тестов ---------------------------------------

  /** Двигает обмен на следующий шаг цепочки waiting → … → finished. */
  advanceStatus(providerExchangeId: string): void {
    const exchange = this.requireExchange(providerExchangeId);
    const index = HAPPY_PATH.findIndex((status) => status === exchange.providerStatus);
    const next = index === -1 ? undefined : HAPPY_PATH[index + 1];
    if (next === undefined) {
      throw new Error(`Cannot advance mock exchange from status "${exchange.providerStatus}"`);
    }
    this.applyStatus(exchange, next);
  }

  /** Задаёт сырой статус напрямую (в том числе нестандартный). */
  setProviderStatus(providerExchangeId: string, providerStatus: string): void {
    this.applyStatus(this.requireExchange(providerExchangeId), providerStatus);
  }

  // --- Внутренняя логика --------------------------------------------------------

  private requireExchange(providerExchangeId: string): StoredExchange {
    const exchange = this.exchanges.get(providerExchangeId);
    if (!exchange) {
      throw new ExchangeProviderError('NOT_FOUND', 'Exchange not found');
    }
    return exchange;
  }

  private applyStatus(exchange: StoredExchange, providerStatus: string): void {
    exchange.providerStatus = providerStatus;
    if (providerStatus === 'finished') {
      exchange.actualFromAmount = exchange.expectedFromAmount;
      exchange.actualToAmount = exchange.expectedToAmount;
    }
  }

  private toStatus(providerExchangeId: string, exchange: StoredExchange): ProviderExchangeStatus {
    return {
      providerExchangeId,
      providerStatus: exchange.providerStatus,
      // Неизвестный сырой статус не отбрасывается, а уходит на проверку.
      status: RAW_STATUS_TO_INTERNAL[exchange.providerStatus] ?? 'VERIFYING',
      actualFromAmount: exchange.actualFromAmount,
      actualToAmount: exchange.actualToAmount,
    };
  }

  private findCurrency(ticker: string, network: string): ProviderCurrency | undefined {
    return this.currencies.find((c) => c.ticker === ticker && c.network === network);
  }

  /** Пара должна существовать в каталоге и иметь курс. Иначе диапазон и котировка недоступны. */
  private requirePair(request: CurrencyPair & { readonly rateType: QuoteRequest['rateType'] }): {
    from: ProviderCurrency;
    to: ProviderCurrency;
    rate: string;
  } {
    const from = this.findCurrency(request.fromCurrency, request.fromNetwork);
    const to = this.findCurrency(request.toCurrency, request.toNetwork);
    const rate = this.rates[pairKey(request)];
    if (!from || !to || rate === undefined) {
      throw new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Currency pair is not supported');
    }
    if (request.rateType === 'FIXED' && !(from.supportsFixedRate && to.supportsFixedRate)) {
      throw new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Fixed rate is not supported for pair');
    }
    return { from, to, rate };
  }

  /** Проверяет пару и сумму, возвращает сумму получения (округление вниз). */
  private calculate(request: QuoteRequest): { toAmount: string; toCurrency: ProviderCurrency } {
    const { rate, to } = this.requirePair(request);

    try {
      parseDecimal(request.fromAmount);
    } catch {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Amount is not a valid decimal');
    }
    if (
      compareDecimal(request.fromAmount, this.minFromAmount) < 0 ||
      compareDecimal(request.fromAmount, this.maxFromAmount) > 0
    ) {
      throw new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is out of allowed range');
    }
    const toAmount = multiplyDecimal(request.fromAmount, rate);
    if (parseDecimal(toAmount) === 0n) {
      throw new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is too small');
    }
    return { toAmount, toCurrency: to };
  }

  private buildQuote(request: QuoteRequest): ProviderQuote {
    const { toAmount } = this.calculate(request);
    if (request.rateType === 'FLOATING') {
      return {
        rateType: 'FLOATING',
        fromAmount: formatDecimal(parseDecimal(request.fromAmount)),
        toAmount,
        rateId: null,
        expiresAt: null,
      };
    }

    this.sequence += 1;
    const rateId = `mock-rate-${String(this.sequence)}`;
    const expiresAt = new Date(this.now().getTime() + this.fixedQuoteTtlMs);
    this.quotes.set(rateId, { request, toAmount, expiresAt });
    return {
      rateType: 'FIXED',
      fromAmount: formatDecimal(parseDecimal(request.fromAmount)),
      toAmount,
      rateId,
      expiresAt,
    };
  }

  private openExchange(request: CreateExchangeRequest): ProviderExchange {
    const { toAmount, toCurrency } = this.calculate(request);
    this.checkPayoutDetails(request, toCurrency);

    let expectedToAmount = toAmount;
    if (request.rateType === 'FIXED') {
      const stored = request.rateId === null ? undefined : this.quotes.get(request.rateId);
      if (!stored || pairKey(stored.request) !== pairKey(request)) {
        throw new ExchangeProviderError('INVALID_REQUEST', 'Unknown rate id for this pair');
      }
      if (compareDecimal(stored.request.fromAmount, request.fromAmount) !== 0) {
        throw new ExchangeProviderError('INVALID_REQUEST', 'Amount differs from quoted amount');
      }
      if (stored.expiresAt.getTime() <= this.now().getTime()) {
        throw new ExchangeProviderError('QUOTE_EXPIRED', 'Fixed quote has expired');
      }
      expectedToAmount = stored.toAmount;
    } else if (request.rateId !== null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Rate id is only valid for fixed rate');
    }

    this.sequence += 1;
    // Идентификатор уникален и между перезапусками процесса: в БД действует
    // unique (provider, providerExchangeId), а состояние мока живёт только в памяти.
    const id = `mock-exchange-${randomUUID()}`;
    const fromCurrency = this.findCurrency(request.fromCurrency, request.fromNetwork);
    const expectedFromAmount = formatDecimal(parseDecimal(request.fromAmount));
    const stored: StoredExchange = {
      expectedFromAmount,
      expectedToAmount,
      payinAddress: `mock-payin-address-${String(this.sequence)}`,
      payinExtraId:
        fromCurrency && fromCurrency.extraId !== 'none'
          ? `mock-payin-memo-${String(this.sequence)}`
          : null,
      providerStatus: 'waiting',
      actualFromAmount: null,
      actualToAmount: null,
    };
    this.exchanges.set(id, stored);

    return {
      providerExchangeId: id,
      payinAddress: stored.payinAddress,
      payinExtraId: stored.payinExtraId,
      providerStatus: stored.providerStatus,
      expectedFromAmount,
      expectedToAmount,
    };
  }

  private checkPayoutDetails(request: CreateExchangeRequest, toCurrency: ProviderCurrency): void {
    if (request.payoutAddress.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Payout address is required');
    }
    if (toCurrency.extraId === 'required' && request.payoutExtraId === null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Payout extraId is required');
    }
    if (toCurrency.extraId === 'none' && request.payoutExtraId !== null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Payout extraId is not supported');
    }
    if (request.refundAddress === null && request.refundExtraId !== null) {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Refund extraId requires refund address');
    }
  }
}
