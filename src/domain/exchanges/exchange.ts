/**
 * Доменная запись обмена. Не зависит от Prisma: суммы — десятичные строки,
 * идентификаторы — внутренние UUID.
 *
 * Список провайдеров должен совпадать с enum `ExchangeProvider` в prisma/schema.prisma
 * (это проверяет tests/domain/exchange-status-sync.test.ts).
 */
import type { RateType } from './exchange-provider.js';
import type { ExchangeStatus } from './status-transitions.js';

export const EXCHANGE_PROVIDER_KINDS = ['MOCK', 'CHANGENOW'] as const;
export type ExchangeProviderKind = (typeof EXCHANGE_PROVIDER_KINDS)[number];

export interface ExchangeRecord {
  readonly id: string;
  readonly userId: string;
  readonly provider: ExchangeProviderKind;
  readonly providerExchangeId: string | null;
  readonly idempotencyKey: string;

  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;

  readonly expectedFromAmount: string;
  readonly expectedToAmount: string | null;
  readonly actualFromAmount: string | null;
  readonly actualToAmount: string | null;

  readonly payinAddress: string | null;
  readonly payinExtraId: string | null;
  readonly payoutAddress: string | null;
  readonly payoutExtraId: string | null;
  readonly refundAddress: string | null;
  readonly refundExtraId: string | null;
  /** Хэш входящей транзакции. NULL, пока провайдер его не прислал. */
  readonly payinHash: string | null;
  /** Хэш выплаты на адрес получателя. */
  readonly payoutHash: string | null;
  /** Хэш возврата, если провайдер вернул средства. */
  readonly refundHash: string | null;

  readonly rateType: RateType;
  readonly providerRateId: string | null;
  readonly quoteExpiresAt: Date | null;

  readonly status: ExchangeStatus;
  readonly providerStatus: string | null;
  readonly statusChangedAt: Date;

  readonly nextCheckAt: Date | null;
  readonly lastCheckedAt: Date | null;
  readonly checkFailureCount: number;

  readonly createdAt: Date;
  readonly updatedAt: Date;
}
