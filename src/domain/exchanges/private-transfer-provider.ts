/**
 * Порт Private Transfer того же партнёра, что и обмен.
 *
 * Это не значение ExchangeProvider и не чек. Чек держит сумму до чужого
 * получения по ссылке; здесь адрес получателя известен сразу, конвертации нет,
 * пользователь задаёт toAmount, а провайдер возвращает fromAmount и обязательный rateId.
 *
 * Реализации лежат в src/integrations/*. Без флага application-слой порт не вызывает.
 * Суммы — десятичные строки. Ответы реального провайдера адаптер валидирует через Zod.
 */
import type { ProviderCallOptions, ProviderExchangeStatus } from './exchange-provider.js';

/** Одна монета и одна сеть: валюта отправки и получения совпадают. */
export interface PrivateTransferAsset {
  readonly currency: string;
  readonly network: string;
}

/** Пара без конвертации: тот же тикер и та же сеть. Другая сеть остаётся обычным обменом. */
export function isSameAsset(
  fromCurrency: string,
  fromNetwork: string,
  toCurrency: string,
  toNetwork: string,
): boolean {
  return fromCurrency === toCurrency && fromNetwork === toNetwork;
}

/** Пользователь задаёт сумму, которую должен получить адресат. */
export interface PrivateTransferEstimateRequest extends PrivateTransferAsset {
  readonly toAmount: string;
}

export interface PrivateTransferEstimate {
  readonly fromAmount: string;
  readonly toAmount: string;
  /** Обязателен для создания перевода и действует до validUntil. */
  readonly rateId: string;
  readonly validUntil: Date;
  readonly warningMessage: string | null;
}

export interface CreatePrivateTransferRequest extends PrivateTransferEstimateRequest {
  readonly address: string;
  readonly extraId: string | null;
  readonly refundAddress: string | null;
  readonly refundExtraId: string | null;
  readonly rateId: string;
}

export interface PrivateTransfer {
  readonly providerTransferId: string;
  readonly fromAmount: string;
  readonly toAmount: string;
  readonly payinAddress: string;
  readonly payoutAddress: string;
  readonly payinExtraId: string | null;
  readonly payoutExtraId: string | null;
}

export interface PrivateTransferProvider {
  estimate(
    request: PrivateTransferEstimateRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransferEstimate>;
  create(
    request: CreatePrivateTransferRequest,
    options?: ProviderCallOptions,
  ): Promise<PrivateTransfer>;
  /**
   * Статус уже созданного перевода. Тот же контракт, что у обмена:
   * адаптер ChangeNOW читает его через GET /v2/exchange/by-id.
   */
  getStatus(
    providerTransferId: string,
    options?: ProviderCallOptions,
  ): Promise<ProviderExchangeStatus>;
}
