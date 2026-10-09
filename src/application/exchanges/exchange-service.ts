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
  type CurrencyPair,
  type ExchangeProvider,
  type ProviderAmountRange,
  type ProviderCurrency,
  type ProviderExchangeStatus,
  type ProviderQuote,
  type RateType,
} from '../../domain/exchanges/exchange-provider.js';
import {
  isSameAsset,
  type PrivateTransferEstimate,
  type PrivateTransferProvider,
} from '../../domain/exchanges/private-transfer-provider.js';
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
import { buildExchangeStatusNotification } from '../notifications/exchange-status-notification.js';
import type { NotificationDraft } from '../notifications/notification-repository.js';
import { computeBackoffDelayMs } from './backoff.js';
import {
  ExchangeNotCancellableError,
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
  /**
   * Перевод одной монеты. Нет значения — пара с тем же тикером и сетью недоступна,
   * и сервис её не отправляет в обмен.
   */
  readonly privateTransfer?: PrivateTransferProvider;
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
  /**
   * Сумма, которую должен получить адресат. Только для той же монеты и сети.
   * Для обычного обмена поле не передаётся: сумму получения считает котировка.
   */
  readonly toAmount?: string;
  readonly rateType: RateType;
  readonly payoutAddress: string;
  readonly payoutExtraId?: string | null;
  readonly refundAddress?: string | null;
  readonly refundExtraId?: string | null;
}

export interface PreviewQuoteInput extends CurrencyPair {
  readonly fromAmount: string;
  readonly rateType: RateType;
}

export interface AmountRangeInput extends CurrencyPair {
  readonly rateType: RateType;
}

export type SyncOutcome = 'transitioned' | 'unchanged' | 'deferred';

export interface SyncResult {
  readonly outcome: SyncOutcome;
  /** Для deferred: машинный код причины. */
  readonly reason?: string;
  readonly exchange: ExchangeRecord;
}

export interface PollSummary {
  /** Сколько обменов захвачено в этот проход. */
  readonly claimed: number;
  readonly transitioned: number;
  readonly unchanged: number;
  readonly deferred: number;
  /** Непредвиденные ошибки по отдельным обменам (обмен будет проверен после истечения lease). */
  readonly errors: number;
}

/** Статусы, в которых у обмена есть провайдерская часть и его нужно опрашивать. */
const PROVIDER_TRACKED_STATUSES: readonly ExchangeStatus[] = [
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'VERIFYING',
];

/** Статусы, в которых пользователь может отказаться: у провайдера обмена ещё нет. */
const CANCELLABLE_STATUSES: readonly ExchangeStatus[] = [
  'DRAFT',
  'QUOTED',
  'AWAITING_CONFIRMATION',
];

interface MoveOptions {
  readonly nextCheckAt: Date | null;
  readonly patch?: ExchangePatch;
  readonly notification?: NotificationDraft;
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

interface DraftAmounts {
  readonly expectedFromAmount: string;
  readonly expectedToAmount: string | null;
  readonly rateType: RateType;
}

interface CreatedLeg {
  readonly providerExchangeId: string;
  readonly payinAddress: string;
  readonly payinExtraId: string | null;
  readonly providerStatus?: string;
  readonly expectedFromAmount: string;
  readonly expectedToAmount: string;
}

export class ExchangeService {
  private readonly repository: ExchangeRepository;
  private readonly provider: ExchangeProvider;
  private readonly privateTransfer: PrivateTransferProvider | undefined;
  private readonly providerKind: ExchangeProviderKind;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly config: ExchangeServiceConfig;

  constructor(deps: ExchangeServiceDependencies) {
    this.repository = deps.repository;
    this.provider = deps.provider;
    this.privateTransfer = deps.privateTransfer;
    this.providerKind = deps.providerKind;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.config = { ...DEFAULT_EXCHANGE_SERVICE_CONFIG, ...deps.config };
  }

  /** Создаёт черновик. Повтор с тем же clientRequestId возвращает тот же обмен. */
  async createDraft(input: CreateDraftInput): Promise<ExchangeRecord> {
    requireNonEmpty(input.clientRequestId, 'clientRequestId');
    requireNonEmpty(input.payoutAddress, 'payoutAddress');
    const sameAsset = isSameAsset(
      input.fromCurrency,
      input.fromNetwork,
      input.toCurrency,
      input.toNetwork,
    );
    const amounts = sameAsset
      ? await this.estimatePrivateTransferDraft(input)
      : this.exchangeDraftAmounts(input);
    const draft = {
      userId: input.userId,
      provider: this.providerKind,
      idempotencyKey: `exchange:${input.userId}:${input.clientRequestId}`,
      fromCurrency: input.fromCurrency,
      fromNetwork: input.fromNetwork,
      toCurrency: input.toCurrency,
      toNetwork: input.toNetwork,
      expectedFromAmount: amounts.expectedFromAmount,
      expectedToAmount: amounts.expectedToAmount,
      payoutAddress: input.payoutAddress,
      payoutExtraId: normalizeOptional(input.payoutExtraId, 'payoutExtraId'),
      refundAddress: normalizeOptional(input.refundAddress, 'refundAddress'),
      refundExtraId: normalizeOptional(input.refundExtraId, 'refundExtraId'),
      rateType: amounts.rateType,
      nextCheckAt: new Date(this.now().getTime() + this.config.draftTtlMs),
    };

    const { exchange, created } = await this.repository.createDraft(draft);
    if (!created) {
      const amountsMatch = sameAsset
        ? exchange.expectedToAmount === draft.expectedToAmount
        : exchange.expectedFromAmount === draft.expectedFromAmount;
      const same =
        exchange.fromCurrency === draft.fromCurrency &&
        exchange.fromNetwork === draft.fromNetwork &&
        exchange.toCurrency === draft.toCurrency &&
        exchange.toNetwork === draft.toNetwork &&
        amountsMatch &&
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

  /** Список валют провайдера (для выбора монеты отправки). */
  async listCurrencies(): Promise<readonly ProviderCurrency[]> {
    return this.provider.getCurrencies(this.callOptions());
  }

  /**
   * Валюты на шаге «что получить». Та же монета и сеть остаётся в списке только
   * когда включён перевод: иначе кнопку нечем завершить.
   */
  async listDestinationCurrencies(from: {
    readonly ticker: string;
    readonly network: string;
  }): Promise<readonly ProviderCurrency[]> {
    const currencies = await this.listCurrencies();
    if (this.privateTransfer !== undefined) return currencies;
    return currencies.filter(
      (currency) => !(currency.ticker === from.ticker && currency.network === from.network),
    );
  }

  /** Та же монета и сеть при включённом переводе. Другая сеть сюда не попадает. */
  isPrivateTransferSelection(pair: CurrencyPair): boolean {
    return (
      this.privateTransfer !== undefined &&
      isSameAsset(pair.fromCurrency, pair.fromNetwork, pair.toCurrency, pair.toNetwork)
    );
  }

  /** Предпросмотр перевода: пользователь задаёт сумму получения. Ничего не сохраняет. */
  async previewPrivateTransfer(input: {
    readonly currency: string;
    readonly network: string;
    readonly toAmount: string;
  }): Promise<PrivateTransferEstimate> {
    return this.requirePrivateTransfer().estimate(
      {
        currency: input.currency,
        network: input.network,
        toAmount: normalizeAmount(input.toAmount),
      },
      this.callOptions(),
    );
  }

  /**
   * Предварительная котировка без создания обмена: быстрая проверка пары и суммы
   * до того, как пользователь начнёт вводить адрес. Ничего не сохраняет.
   */
  async previewQuote(input: PreviewQuoteInput): Promise<ProviderQuote> {
    return this.provider.getQuote(
      {
        fromCurrency: input.fromCurrency,
        fromNetwork: input.fromNetwork,
        toCurrency: input.toCurrency,
        toNetwork: input.toNetwork,
        fromAmount: normalizeAmount(input.fromAmount),
        rateType: input.rateType,
      },
      this.callOptions(),
    );
  }

  /**
   * Допустимый диапазон суммы отправки для уже выбранной пары.
   * Ничего не сохраняет. Суммы приводятся к десятичным строкам.
   */
  async getAmountRange(input: AmountRangeInput): Promise<ProviderAmountRange> {
    const range = await this.provider.getAmountRange(
      {
        fromCurrency: input.fromCurrency,
        fromNetwork: input.fromNetwork,
        toCurrency: input.toCurrency,
        toNetwork: input.toNetwork,
        rateType: input.rateType,
      },
      this.callOptions(),
    );
    return {
      minAmount: normalizeAmount(range.minAmount),
      maxAmount: range.maxAmount === null ? null : normalizeAmount(range.maxAmount),
    };
  }

  /** Обмен пользователя. Чужой обмен неотличим от несуществующего. */
  async getForUser(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    return this.loadOwned(userId, exchangeId);
  }

  /** Последние обмены пользователя, новые первыми. */
  async listForUser(userId: string, limit: number): Promise<ExchangeRecord[]> {
    return this.repository.listByUser(userId, limit);
  }

  /**
   * Доводит черновик до AWAITING_CONFIRMATION (DRAFT → QUOTED → AWAITING_CONFIRMATION).
   * Безопасно повторять: уже выполненные шаги пропускаются.
   */
  async prepareConfirmation(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    let exchange = await this.loadOwned(userId, exchangeId);
    if (exchange.status === 'DRAFT') {
      exchange = await this.requestQuote(userId, exchangeId);
    }
    if (exchange.status === 'QUOTED') {
      exchange = await this.requestConfirmation(userId, exchangeId);
    }
    this.requireStatus(exchange, 'AWAITING_CONFIRMATION');
    return exchange;
  }

  /**
   * Отмена пользователем до создания обмена у провайдера. Закрывает обмен статусом
   * EXPIRED с причиной user_cancelled (отдельного статуса «отменён» в модели нет).
   */
  async cancelByUser(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.loadOwned(userId, exchangeId);
    if (!CANCELLABLE_STATUSES.includes(exchange.status)) {
      throw new ExchangeNotCancellableError(exchange.id, exchange.status);
    }
    return this.move(exchange, 'EXPIRED', 'user_cancelled', { nextCheckAt: null });
  }

  /** DRAFT → QUOTED: запрашивает котировку у провайдера. */
  async requestQuote(userId: string, exchangeId: string): Promise<ExchangeRecord> {
    const exchange = await this.loadOwned(userId, exchangeId);
    this.requireStatus(exchange, 'DRAFT');
    if (this.isPrivateTransferExchange(exchange)) {
      return this.quotePrivateTransfer(exchange);
    }

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
    if (this.isPrivateTransferExchange(exchange) && this.privateTransfer === undefined) {
      throw new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Private transfer is not enabled');
    }

    const now = this.now();
    // Compare-and-set: при гонке проигравший получит ExchangeStatusConflictError
    // и до провайдера не дойдёт.
    const creating = await this.move(exchange, 'CREATING', 'user_confirmed', {
      nextCheckAt: new Date(now.getTime() + this.config.creatingRecoveryDelayMs),
    });

    let created: CreatedLeg;
    try {
      created = await this.openAtProvider(creating);
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
          expectedFromAmount: created.expectedFromAmount,
          expectedToAmount: created.expectedToAmount,
          ...(created.providerStatus !== undefined
            ? { providerStatus: created.providerStatus }
            : {}),
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
   * Временная ошибка провайдера (UNAVAILABLE) не бросается наружу: обмен
   * остаётся в текущем статусе, счётчик неудач растёт, проверка откладывается
   * с backoff. Окончательный отказ повторно не опрашивается: обмен переходит
   * в FAILED и покидает очередь.
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
      remote = await this.fetchRemoteStatus(exchange);
    } catch (error) {
      if (error instanceof ExchangeProviderError) {
        if (!error.retryable) return this.failProviderCheck(exchange, error.code);
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

    // Уведомляем только о переходах, замеченных при сверке с провайдером: на
    // действия пользователя в диалоге (подтверждение, истечение котировки) бот отвечает сам.
    const notification = buildExchangeStatusNotification(exchange, remote.status);
    const updated = await this.move(exchange, remote.status, 'provider_status_changed', {
      nextCheckAt: isTerminalStatus(remote.status)
        ? null
        : new Date(now.getTime() + this.config.pollIntervalMs),
      ...(notification ? { notification } : {}),
      patch: {
        providerStatus: remote.providerStatus,
        lastCheckedAt: now,
        ...(remote.actualFromAmount !== null ? { actualFromAmount: remote.actualFromAmount } : {}),
        ...(remote.actualToAmount !== null ? { actualToAmount: remote.actualToAmount } : {}),
      },
    });
    return { outcome: 'transitioned', exchange: updated };
  }

  /**
   * Один проход фонового опроса: захватывает до `limit` созревших обменов и
   * сверяет каждый с провайдером. Обмены обрабатываются параллельно, ошибка одного
   * не влияет на остальные.
   *
   * Lease (nextCheckAt) покрывает вызов провайдера с запасом. Если проверка
   * не завершилась, обмен вернётся в работу после истечения lease.
   */
  async pollDueExchanges(limit: number): Promise<PollSummary> {
    const now = this.now();
    const ids = await this.repository.claimDueForProviderCheck({
      now,
      limit,
      statuses: PROVIDER_TRACKED_STATUSES,
      provider: this.providerKind,
      leaseUntil: new Date(now.getTime() + this.config.providerTimeoutMs * 2),
    });

    const results = await Promise.allSettled(ids.map((id) => this.syncWithProvider(id)));

    let transitioned = 0;
    let unchanged = 0;
    let deferred = 0;
    let errors = 0;
    results.forEach((result, index) => {
      if (result.status === 'fulfilled') {
        if (result.value.outcome === 'transitioned') transitioned += 1;
        else if (result.value.outcome === 'unchanged') unchanged += 1;
        else deferred += 1;
      } else {
        errors += 1;
        this.logger.error(
          { exchangeId: ids[index], err: result.reason },
          'Unexpected error while checking exchange',
        );
      }
    });
    return { claimed: ids.length, transitioned, unchanged, deferred, errors };
  }

  // --- Внутренняя логика --------------------------------------------------------

  private exchangeDraftAmounts(input: CreateDraftInput): DraftAmounts {
    if (input.toAmount !== undefined) {
      throw new InvalidExchangeInputError('toAmount is only for a same-asset transfer');
    }
    return {
      expectedFromAmount: normalizeAmount(input.fromAmount),
      expectedToAmount: null,
      rateType: input.rateType,
    };
  }

  private async estimatePrivateTransferDraft(input: CreateDraftInput): Promise<DraftAmounts> {
    if (input.toAmount === undefined) {
      throw new InvalidExchangeInputError('toAmount is required for a same-asset transfer');
    }
    const estimate = await this.requirePrivateTransfer().estimate(
      {
        currency: input.fromCurrency,
        network: input.fromNetwork,
        toAmount: normalizeAmount(input.toAmount),
      },
      this.callOptions(),
    );
    return {
      expectedFromAmount: estimate.fromAmount,
      expectedToAmount: estimate.toAmount,
      rateType: 'FIXED',
    };
  }

  private async quotePrivateTransfer(exchange: ExchangeRecord): Promise<ExchangeRecord> {
    const toAmount = this.requireValue(exchange.expectedToAmount, 'expectedToAmount');
    const estimate = await this.requirePrivateTransfer().estimate(
      {
        currency: exchange.fromCurrency,
        network: exchange.fromNetwork,
        toAmount,
      },
      this.callOptions(),
    );
    return this.move(exchange, 'QUOTED', 'quote_obtained', {
      nextCheckAt: estimate.validUntil,
      patch: {
        expectedFromAmount: estimate.fromAmount,
        expectedToAmount: estimate.toAmount,
        providerRateId: estimate.rateId,
        quoteExpiresAt: estimate.validUntil,
      },
    });
  }

  private async openAtProvider(creating: ExchangeRecord): Promise<CreatedLeg> {
    if (!this.isPrivateTransferExchange(creating)) {
      const created = await this.provider.createExchange(
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
      return {
        providerExchangeId: created.providerExchangeId,
        payinAddress: created.payinAddress,
        payinExtraId: created.payinExtraId,
        providerStatus: created.providerStatus,
        expectedFromAmount: created.expectedFromAmount,
        expectedToAmount: created.expectedToAmount,
      };
    }

    const rateId = creating.providerRateId;
    if (rateId === null || rateId.trim() === '') {
      throw new ExchangeProviderError('INVALID_REQUEST', 'Private transfer requires rate id');
    }
    const created = await this.requirePrivateTransfer().create(
      {
        currency: creating.fromCurrency,
        network: creating.fromNetwork,
        toAmount: this.requireValue(creating.expectedToAmount, 'expectedToAmount'),
        address: this.requireValue(creating.payoutAddress, 'payoutAddress'),
        extraId: creating.payoutExtraId,
        refundAddress: creating.refundAddress,
        refundExtraId: creating.refundExtraId,
        rateId,
      },
      this.callOptions(),
    );
    return {
      providerExchangeId: created.providerTransferId,
      payinAddress: created.payinAddress,
      payinExtraId: created.payinExtraId,
      expectedFromAmount: created.fromAmount,
      expectedToAmount: created.toAmount,
    };
  }

  private async fetchRemoteStatus(exchange: ExchangeRecord): Promise<ProviderExchangeStatus> {
    const providerExchangeId = this.requireValue(exchange.providerExchangeId, 'providerExchangeId');
    if (!this.isPrivateTransferExchange(exchange)) {
      return this.provider.getExchangeStatus(providerExchangeId, this.callOptions());
    }
    const transfer = this.privateTransfer;
    if (transfer === undefined) {
      throw new ExchangeProviderError('UNAVAILABLE', 'Private transfer is not enabled');
    }
    return transfer.getStatus(providerExchangeId, this.callOptions());
  }

  private isPrivateTransferExchange(exchange: ExchangeRecord): boolean {
    return isSameAsset(
      exchange.fromCurrency,
      exchange.fromNetwork,
      exchange.toCurrency,
      exchange.toNetwork,
    );
  }

  private requirePrivateTransfer(): PrivateTransferProvider {
    const transfer = this.privateTransfer;
    if (transfer === undefined) {
      throw new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Private transfer is not enabled');
    }
    return transfer;
  }

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
      ...(options.notification ? { notification: options.notification } : {}),
    });
    this.logger.info(
      { exchangeId: exchange.id, from: exchange.status, to, reason },
      'Exchange status changed',
    );
    return updated;
  }

  /**
   * Окончательный отказ провайдера не лечится повтором. Обмен сразу уходит
   * из очереди опроса, иначе одна и та же ошибка будет всплывать без конца.
   */
  private async failProviderCheck(
    exchange: ExchangeRecord,
    code: ExchangeProviderError['code'],
  ): Promise<SyncResult> {
    const reason = `provider_${code.toLowerCase()}`;
    this.logger.error(
      { exchangeId: exchange.id, status: exchange.status, reason },
      'Provider rejected the status check, exchange stopped',
    );
    const notification = buildExchangeStatusNotification(exchange, 'FAILED');
    const updated = await this.move(exchange, 'FAILED', reason, {
      nextCheckAt: null,
      ...(notification ? { notification } : {}),
    });
    return { outcome: 'transitioned', exchange: updated };
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
