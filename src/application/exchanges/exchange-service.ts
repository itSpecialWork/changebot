/**
 * ExchangeService: единственное место, где меняются статусы обмена.
 *
 * Каждый переход проходит через assertTransition и записывается в историю
 * вместе с изменением обмена (атомарно, в репозитории). Вызовы провайдера
 * выполняются вне транзакций БД и с таймаутом.
 *
 * Порядок критичен там, где есть внешний побочный эффект: статус CREATING
 * фиксируется в БД ДО обращения к провайдеру. Благодаря compare-and-set только
 * один из параллельных запросов (например, при двойном нажатии «Подтвердить»)
 * дойдёт до createExchange.
 */
import type { ExchangeProviderKind, ExchangeRecord } from '../../domain/exchanges/exchange.js';
import {
  ExchangeProviderError,
  type ExchangeProvider,
  type ProviderExchangeStatus,
  type RateType,
} from '../../domain/exchanges/exchange-provider.js';
import {
  assertTransition,
  InvalidExchangeStatusTransitionError,
  isTerminalStatus,
  type ExchangeStatus,
} from '../../domain/exchanges/status-transitions.js';
import {
  formatDecimal,
  InvalidDecimalError,
  parseDecimal,
} from '../../domain/shared/decimal-string.js';
import type { Logger } from '../../observability/logger.js';
import { computeBackoffDelayMs } from './backoff.js';
import {
  ExchangeNotFoundError,
  ExchangeNotSyncableError,
  ExchangeStatusConflictError,
  IdempotencyKeyReuseError,
  InvalidExchangeInputError,
  QuoteExpiredError,
} from './errors.js';
import type { ExchangePatch, ExchangeRepository } from './exchange-repository.js';

export interface ExchangeServiceConfig {
  /** Сколько живёт черновик без котировки. */
  readonly draftTtlMs: number;
  /** Срок жизни floating-котировки (провайдер срок для неё не задаёт). */
  readonly floatingQuoteTtlMs: number;
  /** Через сколько worker должен проверить обмен, зависший в CREATING. */
  readonly creatingRecoveryDelayMs: number;
  /** Интервал опроса провайдера для активных обменов. */
  readonly pollIntervalMs: number;
  readonly failureBackoffBaseMs: number;
  readonly failureBackoffMaxMs: number;
  /** После скольких неудач подряд проверка логируется как error (сигнал для разбора). */
  readonly failureAlertThreshold: number;
  /** Таймаут одного вызова провайдера. */
  readonly providerTimeoutMs: number;
}

export const DEFAULT_EXCHANGE_SERVICE_CONFIG: ExchangeServiceConfig = {
  draftTtlMs: 30 * 60_000,
  floatingQuoteTtlMs: 5 * 60_000,
  creatingRecoveryDelayMs: 2 * 60_000,
  pollIntervalMs: 30_000,
  failureBackoffBaseMs: 30_000,
  failureBackoffMaxMs: 15 * 60_000,
  failureAlertThreshold: 10,
  providerTimeoutMs: 10_000,
};

export interface ExchangeServiceDependencies {
  readonly repository: ExchangeRepository;
  readonly provider: ExchangeProvider;
  readonly providerKind: ExchangeProviderKind;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly config?: Partial<ExchangeServiceConfig>;
}

export interface CreateDraftInput {
  readonly userId: string;
  /** Идентификатор запроса от клиента (например, id callback-кнопки): защита от дублей. */
  readonly clientRequestId: string;
  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;
  readonly fromAmount: string;
  readonly rateType: RateType;
  readonly payoutAddress: string;
  readonly payoutExtraId?: string | null;
  readonly refundAddress?: string | null;
  readonly refundExtraId?: string | null;
}

export type SyncOutcome = 'transitioned' | 'unchanged' | 'deferred';

export interface SyncResult {
  readonly outcome: SyncOutcome;
  /** Для deferred: машинный код причины. */
  readonly reason?: string;
  readonly exchange: ExchangeRecord;
}

/** Статусы, в которых у обмена есть провайдерская часть и его нужно опрашивать. */
const PROVIDER_TRACKED_STATUSES: readonly ExchangeStatus[] = [
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'VERIFYING',
];

interface MoveOptions {
  readonly nextCheckAt: Date | null;
  readonly patch?: ExchangePatch;
}

function requireNonEmpty(value: string, field: string): void {
  if (value.trim() === '') {
    throw new InvalidExchangeInputError(`${field} must not be empty`);
  }
}

function normalizeOptional(value: string | null | undefined, field: string): string | null {
  if (value === null || value === undefined) return null;
  requireNonEmpty(value, field);
  return value;
}

function normalizeAmount(value: string): string {
  let scaled: bigint;
  try {
    scaled = parseDecimal(value);
  } catch (error) {
    if (error instanceof InvalidDecimalError) {
      throw new InvalidExchangeInputError('fromAmount is not a valid decimal');
    }
    throw error;
  }
  if (scaled <= 0n) {
    throw new InvalidExchangeInputError('fromAmount must be positive');
  }
  return formatDecimal(scaled);
}

export class ExchangeService {
  private readonly repository: ExchangeRepository;
  private readonly provider: ExchangeProvider;
  private readonly providerKind: ExchangeProviderKind;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: ExchangeServiceConfig;

  constructor(deps: ExchangeServiceDependencies) {
    this.repository = deps.repository;
    this.provider = deps.provider;
    this.providerKind = deps.providerKind;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.config = { ...DEFAULT_EXCHANGE_SERVICE_CONFIG, ...deps.config };
  }

  /** Создаёт черновик. Повтор с тем же clientRequestId возвращает тот же обмен. */
  async createDraft(input: CreateDraftInput): Promise<ExchangeRecord> {
    requireNonEmpty(input.clientRequestId, 'clientRequestId');
    requireNonEmpty(input.payoutAddress, 'payoutAddress');
    const draft = {
      userId: input.userId,
      provider: this.providerKind,
      idempotencyKey: `exchange:${input.userId}:${input.clientRequestId}`,
      fromCurrency: input.fromCurrency,
      fromNetwork: input.fromNetwork,
      toCurrency: input.toCurrency,
      toNetwork: input.toNetwork,
      expectedFromAmount: normalizeAmount(input.fromAmount),
      payoutAddress: input.payoutAddress,
      payoutExtraId: normalizeOptional(input.payoutExtraId, 'payoutExtraId'),
      refundAddress: normalizeOptional(input.refundAddress, 'refundAddress'),
      refundExtraId: normalizeOptional(input.refundExtraId, 'refundExtraId'),
      rateType: input.rateType,
      nextCheckAt: new Date(this.now().getTime() + this.config.draftTtlMs),
    };

    const { exchange, created } = await this.repository.createDraft(draft);
    if (!created) {
      const same =
        exchange.fromCurrency === draft.fromCurrency &&
        exchange.fromNetwork === draft.fromNetwork &&
        exchange.toCurrency === draft.toCurrency &&
        exchange.toNetwork === draft.toNetwork &&
        exchange.expectedFromAmount === draft.expectedFromAmount &&
        exchange.rateType === draft.rateType &&
        exchange.payoutAddress === draft.payoutAddress &&
        exchange.payoutExtraId === draft.payoutExtraId &&
        exchange.refundAddress === draft.refundAddress &&
        exchange.refundExtraId === draft.refundExtraId;
      if (!same) {
        throw new IdempotencyKeyReuseError();
      }
    }
    return exchange;
  }

  /** DRAFT → QUOTED: запрашивает котировку у провайдера. */
  async requestQuote(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.loadOwned(userId, exchangeId);
    this.requireStatus(exchange, 'DRAFT');

    const quote = await this.provider.getQuote(
      {
        fromCurrency: exchange.fromCurrency,
        fromNetwork: exchange.fromNetwork,
        toCurrency: exchange.toCurrency,
        toNetwork: exchange.toNetwork,
        fromAmount: exchange.expectedFromAmount,
        rateType: exchange.rateType,
      },
      this.callOptions(),
    );

    const quoteExpiresAt =
      quote.expiresAt ?? new Date(this.now().getTime() + this.config.floatingQuoteTtlMs);
    return this.move(exchange, 'QUOTED', 'quote_obtained', {
      nextCheckAt: quoteExpiresAt,
      patch: { expectedToAmount: quote.toAmount, providerRateId: quote.rateId, quoteExpiresAt },
    });
  }

  /** QUOTED → AWAITING_CONFIRMATION: котировка показана пользователю. */
  async requestConfirmation(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.loadOwned(userId, exchangeId);
    this.requireStatus(exchange, 'QUOTED');
    await this.expireIfQuoteExpired(exchange);

    return this.move(exchange, 'AWAITING_CONFIRMATION', 'confirmation_requested', {
      nextCheckAt: this.requireQuoteDeadline(exchange),
    });
  }

  /**
   * AWAITING_CONFIRMATION → CREATING → WAITING_DEPOSIT.
   *
   * Исходы вызова провайдера:
   *  - успех: WAITING_DEPOSIT;
   *  - окончательный отказ (не UNAVAILABLE): FAILED, ошибка пробрасывается;
   *  - временная ошибка или таймаут: исход неизвестен (провайдер мог создать обмен),
   *    поэтому обмен остаётся в CREATING для восстановления, ошибка пробрасывается.
   */
  async confirmAndCreate(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.loadOwned(userId, exchangeId);
    this.requireStatus(exchange, 'AWAITING_CONFIRMATION');
    await this.expireIfQuoteExpired(exchange);

    const now = this.now();
    // Compare-and-set: при гонке проигравший получит ExchangeStatusConflictError
    // и до провайдера не дойдёт.
    const creating = await this.move(exchange, 'CREATING', 'user_confirmed', {
      nextCheckAt: new Date(now.getTime() + this.config.creatingRecoveryDelayMs),
    });

    let created;
    try {
      created = await this.provider.createExchange(
        {
          fromCurrency: creating.fromCurrency,
          fromNetwork: creating.fromNetwork,
          toCurrency: creating.toCurrency,
          toNetwork: creating.toNetwork,
          fromAmount: creating.expectedFromAmount,
          rateType: creating.rateType,
          payoutAddress: this.requireValue(creating.payoutAddress, 'payoutAddress'),
          payoutExtraId: creating.payoutExtraId,
          refundAddress: creating.refundAddress,
          refundExtraId: creating.refundExtraId,
          rateId: creating.providerRateId,
        },
        this.callOptions(),
      );
    } catch (error) {
      if (error instanceof ExchangeProviderError && !error.retryable) {
        await this.move(creating, 'FAILED', `create_failed_${error.code.toLowerCase()}`, {
          nextCheckAt: null,
        });
      } else {
        this.logger.warn(
          { exchangeId, err: error },
          'Provider createExchange outcome unknown, exchange stays in CREATING',
        );
      }
      throw error;
    }

    try {
      return await this.move(creating, 'WAITING_DEPOSIT', 'provider_exchange_created', {
        nextCheckAt: new Date(this.now().getTime() + this.config.pollIntervalMs),
        patch: {
          providerExchangeId: created.providerExchangeId,
          payinAddress: created.payinAddress,
          payinExtraId: created.payinExtraId,
          providerStatus: created.providerStatus,
          expectedFromAmount: created.expectedFromAmount,
          expectedToAmount: created.expectedToAmount,
        },
      });
    } catch (error) {
      // Обмен у провайдера создан, а сохранить результат не удалось: нужен ручной разбор.
      this.logger.error(
        { exchangeId, providerExchangeId: created.providerExchangeId, err: error },
        'Provider exchange created but local state was not saved',
      );
      throw error;
    }
  }

  /**
   * Сверяет обмен с провайдером и применяет новый статус.
   *
   * Метод не бросает исключений при проблемах провайдера: такие случаи
   * возвращаются как outcome = 'deferred' (счётчик неудач растёт, проверка
   * откладывается с backoff, статус не меняется).
   */
  async syncWithProvider(exchangeId: string): Promise<SyncResult> {
    const exchange = await this.repository.findById(exchangeId);
    if (!exchange) {
      throw new ExchangeNotFoundError(exchangeId);
    }
    if (
      !PROVIDER_TRACKED_STATUSES.includes(exchange.status) ||
      exchange.providerExchangeId === null
    ) {
      throw new ExchangeNotSyncableError(exchangeId, exchange.status);
    }

    let remote: ProviderExchangeStatus;
    try {
      remote = await this.provider.getExchangeStatus(
        exchange.providerExchangeId,
        this.callOptions(),
      );
    } catch (error) {
      if (error instanceof ExchangeProviderError) {
        return this.defer(exchange, `provider_${error.code.toLowerCase()}`);
      }
      throw error;
    }

    const now = this.now();

    if (
      remote.status === 'FINISHED' &&
      (remote.actualFromAmount === null || remote.actualToAmount === null)
    ) {
      // Политика: завершение без фактических сумм не фиксируем и не подставляем
      // выдуманные значения. Обмен остаётся в текущем статусе и перепроверяется.
      return this.defer(exchange, 'finished_without_amounts');
    }

    if (remote.status === exchange.status) {
      const updated = await this.repository.recordCheckSuccess({
        exchangeId,
        expectedStatus: exchange.status,
        at: now,
        nextCheckAt: new Date(now.getTime() + this.config.pollIntervalMs),
        providerStatus: remote.providerStatus,
      });
      return { outcome: 'unchanged', exchange: updated };
    }

    try {
      assertTransition(exchange.status, remote.status);
    } catch (error) {
      if (error instanceof InvalidExchangeStatusTransitionError) {
        this.logger.error(
          { exchangeId, from: error.from, to: error.to },
          'Provider reported an impossible status transition',
        );
        return this.defer(exchange, 'invalid_transition');
      }
      throw error;
    }

    const updated = await this.move(exchange, remote.status, 'provider_status_changed', {
      nextCheckAt: isTerminalStatus(remote.status)
        ? null
        : new Date(now.getTime() + this.config.pollIntervalMs),
      patch: {
        providerStatus: remote.providerStatus,
        lastCheckedAt: now,
        ...(remote.actualFromAmount !== null ? { actualFromAmount: remote.actualFromAmount } : {}),
        ...(remote.actualToAmount !== null ? { actualToAmount: remote.actualToAmount } : {}),
      },
    });
    return { outcome: 'transitioned', exchange: updated };
  }

  // --- Внутренняя логика --------------------------------------------------------

  private async loadOwned(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.repository.findById(exchangeId);
    // Чужой обмен неотличим от несуществующего.
    if (exchange?.userId !== userId) {
      throw new ExchangeNotFoundError(exchangeId);
    }
    return exchange;
  }

  private requireStatus(exchange: ExchangeRecord, expected: ExchangeStatus): void {
    if (exchange.status !== expected) {
      throw new ExchangeStatusConflictError(exchange.id, expected, exchange.status);
    }
  }

  private requireQuoteDeadline(exchange: ExchangeRecord): Date {
    return this.requireValue(exchange.quoteExpiresAt, 'quoteExpiresAt');
  }

  private requireValue<T>(value: T | null, field: string): T {
    if (value === null) {
      throw new Error(`Invariant violated: ${field} is missing`);
    }
    return value;
  }

  private callOptions(): { signal: AbortSignal } {
    return { signal: AbortSignal.timeout(this.config.providerTimeoutMs) };
  }

  private async expireIfQuoteExpired(exchange: ExchangeRecord): Promise<void> {
    const deadline = this.requireQuoteDeadline(exchange);
    if (deadline.getTime() <= this.now().getTime()) {
      await this.move(exchange, 'EXPIRED', 'quote_expired', { nextCheckAt: null });
      throw new QuoteExpiredError(exchange.id);
    }
  }

  private async move(
    exchange: ExchangeRecord,
    to: ExchangeStatus,
    reason: string,
    options: MoveOptions,
  ): Promise<ExchangeRecord> {
    assertTransition(exchange.status, to);
    const updated = await this.repository.transition({
      exchangeId: exchange.id,
      from: exchange.status,
      to,
      reason,
      at: this.now(),
      nextCheckAt: options.nextCheckAt,
      ...(options.patch ? { patch: options.patch } : {}),
    });
    this.logger.info(
      { exchangeId: exchange.id, from: exchange.status, to, reason },
      'Exchange status changed',
    );
    return updated;
  }

  private async defer(exchange: ExchangeRecord, reason: string): Promise<SyncResult> {
    const now = this.now();
    const failures = exchange.checkFailureCount + 1;
    const delay = computeBackoffDelayMs(
      failures,
      this.config.failureBackoffBaseMs,
      this.config.failureBackoffMaxMs,
    );
    const updated = await this.repository.recordCheckFailure({
      exchangeId: exchange.id,
      expectedStatus: exchange.status,
      at: now,
      nextCheckAt: new Date(now.getTime() + delay),
    });

    const logContext = { exchangeId: exchange.id, status: exchange.status, reason, failures };
    if (failures >= this.config.failureAlertThreshold) {
      this.logger.error(logContext, 'Exchange check keeps failing, manual review required');
    } else {
      this.logger.warn(logContext, 'Exchange check deferred');
    }
    return { outcome: 'deferred', reason, exchange: updated };
  }
}
