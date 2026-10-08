/**
 * NotificationService: доставка уведомлений из outbox.
 *
 * Отправка выполняется вне транзакций БД: сначала запись захватывается
 * (PENDING → PROCESSING), затем идёт вызов sender с таймаутом, затем результат
 * фиксируется отдельным коротким запросом. Доставка at-least-once: при падении
 * между отправкой и фиксацией сообщение может прийти повторно.
 *
 * Лимит скорости: записи отправляются последовательно с паузой minSendIntervalMs
 * (по умолчанию ~20 сообщений в секунду, ниже общего лимита Telegram ~30/с).
 */
import type { Logger } from '../../observability/logger.js';
import { computeBackoffDelayMs } from '../exchanges/backoff.js';
import { InvalidNotificationError, renderNotification } from './exchange-status-notification.js';
import type {
  ClaimedNotification,
  NotificationClaimRef,
  NotificationOutboxRepository,
} from './notification-repository.js';
import { NotificationSendError, type NotificationSender } from './notification-sender.js';
import { sanitizeErrorForStorage } from './sanitize-error.js';

export interface NotificationServiceConfig {
  /** Максимум попыток доставки, включая первую. */
  readonly maxAttempts: number;
  /**
   * Через сколько запись в PROCESSING считается зависшей. Должен с запасом превышать
   * время обработки пакета: batchSize × (sendTimeoutMs + minSendIntervalMs).
   */
  readonly lockTtlMs: number;
  readonly retryBackoffBaseMs: number;
  readonly retryBackoffMaxMs: number;
  /** Таймаут одной отправки. */
  readonly sendTimeoutMs: number;
  /** Пауза между отправками внутри пакета (rate limiting). */
  readonly minSendIntervalMs: number;
}

export const DEFAULT_NOTIFICATION_SERVICE_CONFIG: NotificationServiceConfig = {
  maxAttempts: 8,
  lockTtlMs: 5 * 60_000,
  retryBackoffBaseMs: 30_000,
  retryBackoffMaxMs: 30 * 60_000,
  sendTimeoutMs: 10_000,
  minSendIntervalMs: 50,
};

export interface NotificationServiceDependencies {
  readonly repository: NotificationOutboxRepository;
  readonly sender: NotificationSender;
  readonly logger: Logger;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly config?: Partial<NotificationServiceConfig>;
}

export interface DispatchSummary {
  /** Сколько зависших записей возвращено в очередь / закрыто как FAILED. */
  readonly requeued: number;
  readonly expired: number;
  /** Сколько записей захвачено в этот проход. */
  readonly claimed: number;
  readonly sent: number;
  /** Отложены на повторную попытку. */
  readonly retried: number;
  /** Окончательно не доставлены (в том числе из-за заблокированного бота). */
  readonly failed: number;
  /** Запись перехвачена другим исполнителем после истечения lock TTL. */
  readonly lost: number;
  /** Сбой при фиксации результата: запись вернётся в очередь после lock TTL. */
  readonly errors: number;
}

type DeliveryOutcome = 'sent' | 'retried' | 'failed' | 'lost';

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class NotificationService {
  private readonly repository: NotificationOutboxRepository;
  private readonly sender: NotificationSender;
  private readonly logger: Logger;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly config: NotificationServiceConfig;

  constructor(deps: NotificationServiceDependencies) {
    this.repository = deps.repository;
    this.sender = deps.sender;
    this.logger = deps.logger;
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? defaultSleep;
    this.config = { ...DEFAULT_NOTIFICATION_SERVICE_CONFIG, ...deps.config };
  }

  /** Один проход: освобождает зависшие записи и доставляет до `limit` созревших. */
  async dispatchDue(limit: number): Promise<DispatchSummary> {
    const start = this.now();
    const released = await this.repository.releaseStale({
      now: start,
      lockedBefore: new Date(start.getTime() - this.config.lockTtlMs),
      maxAttempts: this.config.maxAttempts,
    });
    if (released.requeued > 0 || released.failed > 0) {
      this.logger.warn(released, 'Released stale notifications');
    }

    const claimed = await this.repository.claimDue({ now: start, limit });

    const counters = { sent: 0, retried: 0, failed: 0, lost: 0, errors: 0 };
    for (const [index, notification] of claimed.entries()) {
      if (index > 0 && this.config.minSendIntervalMs > 0) {
        await this.sleep(this.config.minSendIntervalMs);
      }
      try {
        counters[await this.deliver(notification)] += 1;
      } catch (error) {
        // Сбой БД при фиксации результата: запись останется PROCESSING и вернётся
        // в очередь после lock TTL. Остальные записи пакета обрабатываются дальше.
        counters.errors += 1;
        this.logger.error(
          { notificationId: notification.id, err: error },
          'Failed to record notification delivery result',
        );
      }
    }

    return {
      requeued: released.requeued,
      expired: released.failed,
      claimed: claimed.length,
      ...counters,
    };
  }

  private async deliver(notification: ClaimedNotification): Promise<DeliveryOutcome> {
    const ref: NotificationClaimRef = {
      id: notification.id,
      attempts: notification.attempts,
      at: this.now(),
    };

    if (notification.botBlockedAt !== null) {
      return this.fail(ref, 'bot_blocked');
    }

    let text: string;
    try {
      text = renderNotification(notification.type, notification.payload);
    } catch (error) {
      if (error instanceof InvalidNotificationError) {
        this.logger.error(
          { notificationId: notification.id, type: notification.type, code: error.code },
          'Notification cannot be rendered',
        );
        return this.fail(ref, error.code);
      }
      throw error;
    }

    try {
      await this.sender.send(
        { chatId: notification.telegramId, text },
        { signal: AbortSignal.timeout(this.config.sendTimeoutMs) },
      );
    } catch (error) {
      return this.handleSendError(notification, ref, error);
    }

    const applied = await this.repository.markSent({ ...ref, at: this.now() });
    return this.outcome(applied, 'sent', notification);
  }

  private async handleSendError(
    notification: ClaimedNotification,
    ref: NotificationClaimRef,
    error: unknown,
  ): Promise<DeliveryOutcome> {
    const sendError = error instanceof NotificationSendError ? error : undefined;
    const reason = sendError ? `${sendError.code}: ${sendError.message}` : error;
    const stored = sanitizeErrorForStorage(reason);
    const logContext = {
      notificationId: notification.id,
      type: notification.type,
      attempts: notification.attempts,
      kind: sendError?.kind ?? 'TRANSIENT',
      code: sendError?.code,
    };

    if (sendError?.kind === 'BOT_BLOCKED') {
      this.logger.info(logContext, 'User blocked the bot, notification dropped');
      const applied = await this.repository.markBotBlocked({
        ...ref,
        at: this.now(),
        userId: notification.userId,
      });
      return this.outcome(applied, 'failed', notification);
    }

    if (sendError?.kind === 'PERMANENT') {
      this.logger.warn(logContext, 'Notification delivery failed permanently');
      return this.fail(ref, stored);
    }

    // TRANSIENT и любые неожиданные ошибки sender.
    if (notification.attempts >= this.config.maxAttempts) {
      this.logger.error(logContext, 'Notification delivery attempts exhausted');
      return this.fail(ref, stored);
    }
    const now = this.now();
    const backoff = computeBackoffDelayMs(
      notification.attempts,
      this.config.retryBackoffBaseMs,
      this.config.retryBackoffMaxMs,
    );
    const delay = Math.max(backoff, sendError?.retryAfterMs ?? 0);
    this.logger.warn(logContext, 'Notification delivery failed, will retry');
    const applied = await this.repository.markRetry({
      ...ref,
      at: now,
      nextAttemptAt: new Date(now.getTime() + delay),
      error: stored,
    });
    return this.outcome(applied, 'retried', notification);
  }

  private async fail(ref: NotificationClaimRef, error: string): Promise<DeliveryOutcome> {
    const applied = await this.repository.markFailed({ ...ref, at: this.now(), error });
    return applied ? 'failed' : 'lost';
  }

  private outcome(
    applied: boolean,
    success: Exclude<DeliveryOutcome, 'lost'>,
    notification: ClaimedNotification,
  ): DeliveryOutcome {
    if (applied) return success;
    this.logger.warn(
      { notificationId: notification.id, attempts: notification.attempts },
      'Notification was taken over by another worker, result ignored',
    );
    return 'lost';
  }
}
