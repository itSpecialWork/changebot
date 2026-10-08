/**
 * Порт хранилища обменов. Реализация (Prisma) лежит в src/database/repositories.
 *
 * Гарантии, которые обязана давать реализация:
 *  - каждое изменение статуса атомарно с записью в ExchangeStatusHistory;
 *  - переход выполняется как compare-and-set по ожидаемому статусу
 *    (при расхождении — ExchangeStatusConflictError);
 *  - транзакция никогда не охватывает вызов внешнего провайдера.
 */
import type { ExchangeRecord, ExchangeProviderKind } from '../../domain/exchanges/exchange.js';
import type { RateType } from '../../domain/exchanges/exchange-provider.js';
import type { ExchangeStatus } from '../../domain/exchanges/status-transitions.js';
import type { NotificationDraft } from '../notifications/notification-repository.js';

export interface NewDraft {
  readonly userId: string;
  readonly provider: ExchangeProviderKind;
  readonly idempotencyKey: string;
  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;
  readonly expectedFromAmount: string;
  readonly payoutAddress: string;
  readonly payoutExtraId: string | null;
  readonly refundAddress: string | null;
  readonly refundExtraId: string | null;
  readonly rateType: RateType;
  /** Дедлайн черновика: после него обмен подлежит истечению. */
  readonly nextCheckAt: Date;
}

/** Поля, которые могут измениться вместе с переходом статуса. */
export interface ExchangePatch {
  readonly expectedFromAmount?: string;
  readonly expectedToAmount?: string;
  readonly actualFromAmount?: string;
  readonly actualToAmount?: string;
  readonly providerExchangeId?: string;
  readonly providerRateId?: string | null;
  readonly quoteExpiresAt?: Date;
  readonly payinAddress?: string;
  readonly payinExtraId?: string | null;
  readonly providerStatus?: string;
  readonly lastCheckedAt?: Date;
}

export interface TransitionParams {
  readonly exchangeId: string;
  readonly from: ExchangeStatus;
  readonly to: ExchangeStatus;
  /** Машинный код причины для истории, например quote_obtained. */
  readonly reason: string;
  readonly at: Date;
  /** NULL допустим только для терминальных статусов (инвариант в БД). */
  readonly nextCheckAt: Date | null;
  readonly patch?: ExchangePatch;
  /**
   * Уведомление для пользователя. Записывается в outbox в той же транзакции,
   * что и переход, с dedupeKey по записи истории: переход без уведомления
   * и уведомление без перехода невозможны.
   */
  readonly notification?: NotificationDraft;
}

export interface CheckFailureParams {
  readonly exchangeId: string;
  readonly expectedStatus: ExchangeStatus;
  readonly at: Date;
  readonly nextCheckAt: Date;
}

export interface CheckSuccessParams {
  readonly exchangeId: string;
  readonly expectedStatus: ExchangeStatus;
  readonly at: Date;
  readonly nextCheckAt: Date;
  readonly providerStatus: string;
}

export interface ClaimDueParams {
  /** Обмены с nextCheckAt <= now считаются созревшими. */
  readonly now: Date;
  readonly limit: number;
  /** Статусы, которые нужно опрашивать у провайдера. Обмен без providerExchangeId не берётся. */
  readonly statuses: readonly ExchangeStatus[];
  /** Новый nextCheckAt захваченных обменов (lease): до этого момента их не возьмёт другой worker. */
  readonly leaseUntil: Date;
}

export interface ExchangeRepository {
  /**
   * Создаёт черновик вместе с первой записью истории. Повторный вызов с тем же
   * idempotencyKey возвращает существующий обмен (created = false).
   */
  createDraft(draft: NewDraft): Promise<{ exchange: ExchangeRecord; created: boolean }>;

  findById(exchangeId: string): Promise<ExchangeRecord | null>;

  /** Последние обмены пользователя, новые первыми. */
  listByUser(userId: string, limit: number): Promise<ExchangeRecord[]>;

  /** Compare-and-set переход статуса с записью истории. */
  transition(params: TransitionParams): Promise<ExchangeRecord>;

  /** Неудачная проверка у провайдера: счётчик +1, новый nextCheckAt, статус не меняется. */
  recordCheckFailure(params: CheckFailureParams): Promise<ExchangeRecord>;

  /** Успешная проверка без смены внутреннего статуса: счётчик сбрасывается. */
  recordCheckSuccess(params: CheckSuccessParams): Promise<ExchangeRecord>;

  /**
   * Атомарно захватывает созревшие обмены и сдвигает их nextCheckAt на leaseUntil.
   * Параллельные вызовы не получают один и тот же обмен. Если worker упал, lease
   * истекает, и обмен будет проверен снова. Возвращает идентификаторы обменов.
   */
  claimDueForProviderCheck(params: ClaimDueParams): Promise<string[]>;
}
