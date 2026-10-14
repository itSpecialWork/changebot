/**
 * Порт внешнего провайдера обмена (ChangeNOW, позже другие).
 *
 * Это только контракт: никакой реализации, HTTP и зависимостей от БД здесь нет.
 * Адаптеры лежат в src/integrations/*. Telegram-обработчики и HTTP-маршруты
 * провайдера не вызывают: к нему обращается только application-слой.
 *
 * Соглашения:
 *  - суммы — десятичные строки (см. domain/shared/decimal-string.ts), не number;
 *  - валюта всегда указывается вместе с blockchain network;
 *  - значения тикеров и сетей — в нормализованном нижнем регистре (словарь провайдера);
 *  - extraId покрывает memo, tag и destination tag;
 *  - ответы реального провайдера адаптер обязан валидировать через Zod
 *    до того, как вернуть результат через этот интерфейс.
 */
import type { ExchangeStatus } from './status-transitions.js';

export const RATE_TYPES = ['FIXED', 'FLOATING'] as const;
export type RateType = (typeof RATE_TYPES)[number];

/** Нужен ли валюте extraId (memo/tag) при получении средств. */
export type ExtraIdRequirement = 'none' | 'optional' | 'required';

export interface ProviderCurrency {
  readonly ticker: string;
  readonly network: string;
  readonly name: string;
  readonly extraId: ExtraIdRequirement;
  readonly supportsFixedRate: boolean;
  /**
   * Отметка провайдера «популярная валюта». Первый экран бота её не использует:
   * там свой короткий список, а полный каталог открывается отдельной кнопкой.
   */
  readonly featured: boolean;
}

export interface CurrencyPair {
  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;
}

/**
 * `send` — `fromAmount` это сумма отправки, тип direct.
 * `receive` — `fromAmount` это сумма, которую должен получить адресат.
 * Обратная котировка только фиксированная: провайдер сам возвращает больший депозит.
 */
export type QuoteDirection = 'send' | 'receive';

/** Прямой поток задаёт сумму отправки. Обратный — сумму получения. */
export interface QuoteRequest extends CurrencyPair {
  readonly fromAmount: string;
  readonly rateType: RateType;
  readonly direction?: QuoteDirection;
}

/** Запрос допустимого диапазона суммы отправки для пары и типа курса. */
export interface AmountRangeRequest extends CurrencyPair {
  readonly rateType: RateType;
}

/** Минимум обязателен. Максимум есть не у каждой пары. Суммы — десятичные строки. */
export interface ProviderAmountRange {
  readonly minAmount: string;
  readonly maxAmount: string | null;
}

export interface ProviderQuote {
  readonly rateType: RateType;
  readonly fromAmount: string;
  readonly toAmount: string;
  /** Идентификатор зафиксированного курса. Только для FIXED, иначе null. */
  readonly rateId: string | null;
  /**
   * Срок действия курса у провайдера. Для FLOATING провайдер срок не задаёт (null);
   * срок жизни такой котировки определяет application-слой.
   */
  readonly expiresAt: Date | null;
}

export interface CreateExchangeRequest extends QuoteRequest {
  readonly payoutAddress: string;
  readonly payoutExtraId: string | null;
  readonly refundAddress: string | null;
  readonly refundExtraId: string | null;
  /** Обязателен для FIXED: идентификатор из ProviderQuote.rateId. */
  readonly rateId: string | null;
}

export interface ProviderExchange {
  readonly providerExchangeId: string;
  readonly payinAddress: string;
  readonly payinExtraId: string | null;
  /** Оригинальный статус провайдера. */
  readonly providerStatus: string;
  readonly expectedFromAmount: string;
  readonly expectedToAmount: string;
}

/**
 * Внутренние статусы, которые может вернуть провайдер уже созданного обмена.
 * Сопоставление «сырой статус → внутренний» делает адаптер провайдера.
 * Неизвестный сырой статус адаптер сопоставляет с VERIFYING, а не отбрасывает.
 */
export const PROVIDER_EXCHANGE_STATUSES = [
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'VERIFYING',
  'FINISHED',
  'FAILED',
  'REFUNDED',
] as const satisfies readonly ExchangeStatus[];

export type ProviderExchangeStatusName = (typeof PROVIDER_EXCHANGE_STATUSES)[number];

export interface ProviderExchangeStatus {
  readonly providerExchangeId: string;
  readonly providerStatus: string;
  readonly status: ProviderExchangeStatusName;
  readonly actualFromAmount: string | null;
  readonly actualToAmount: string | null;
  /** Хэш депозита. NULL, если провайдер его ещё не знает. */
  readonly payinHash: string | null;
  /** Хэш выплаты. */
  readonly payoutHash: string | null;
  /** Хэш возврата. */
  readonly refundHash: string | null;
}

export interface ProviderCallOptions {
  /** Для таймаутов и отмены: адаптер обязан прервать запрос при срабатывании. */
  readonly signal?: AbortSignal;
}

/**
 * Коды ошибок провайдера. Только UNAVAILABLE считается временной
 * (можно повторить с ограничением числа попыток), остальные — окончательные.
 */
export type ExchangeProviderErrorCode =
  | 'UNAVAILABLE'
  | 'INVALID_REQUEST'
  | 'PAIR_NOT_SUPPORTED'
  | 'AMOUNT_OUT_OF_RANGE'
  | 'QUOTE_EXPIRED'
  | 'NOT_FOUND';

export class ExchangeProviderError extends Error {
  constructor(
    public readonly code: ExchangeProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ExchangeProviderError';
  }

  get retryable(): boolean {
    return this.code === 'UNAVAILABLE';
  }
}

export interface ExchangeProvider {
  getCurrencies(options?: ProviderCallOptions): Promise<readonly ProviderCurrency[]>;
  getQuote(request: QuoteRequest, options?: ProviderCallOptions): Promise<ProviderQuote>;
  getAmountRange(
    request: AmountRangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderAmountRange>;
  createExchange(
    request: CreateExchangeRequest,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchange>;
  getExchangeStatus(
    providerExchangeId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus>;
}
