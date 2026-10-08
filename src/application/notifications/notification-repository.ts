/**
 * Порт хранилища outbox уведомлений. Реализация (Prisma) лежит в src/database/repositories.
 *
 * Постановка в очередь выполняется не здесь, а в ExchangeRepository.transition:
 * запись outbox создаётся в той же транзакции, что и смена статуса обмена.
 *
 * Модель доставки: at-least-once. Если процесс упал после отправки, но до markSent,
 * запись вернётся в очередь по истечении lock TTL и сообщение может прийти повторно.
 *
 * Каждый claim увеличивает `attempts`, поэтому пара (id, attempts) однозначно
 * определяет «владение» записью: markSent/markRetry/markFailed/markBotBlocked
 * применяются, только если запись всё ещё PROCESSING с тем же `attempts`.
 * Иначе (запись перехвачена после истечения lock TTL) методы возвращают false.
 */

/** Уведомление, которое нужно поставить в очередь вместе со сменой статуса. */
export interface NotificationDraft {
  /** Тип уведомления, например EXCHANGE_STATUS_CHANGED. */
  readonly type: string;
  /** Минимальные параметры шаблона. Секретов и адресов быть не должно. */
  readonly payload: Record<string, string>;
}

/** Захваченная запись вместе с данными получателя. */
export interface ClaimedNotification {
  readonly id: string;
  readonly userId: string;
  readonly exchangeId: string | null;
  readonly type: string;
  /** Сырой JSON из БД: проверяется Zod перед использованием. */
  readonly payload: unknown;
  /** Номер текущей попытки (уже включает эту). */
  readonly attempts: number;
  readonly telegramId: bigint;
  readonly botBlockedAt: Date | null;
}

export interface ClaimDueNotificationsParams {
  readonly now: Date;
  readonly limit: number;
}

export interface ReleaseStaleParams {
  readonly now: Date;
  /** Записи PROCESSING с lockedAt <= lockedBefore считаются зависшими. */
  readonly lockedBefore: Date;
  /** Зависшие записи, исчерпавшие попытки, переводятся в FAILED, остальные в PENDING. */
  readonly maxAttempts: number;
}

export interface ReleaseStaleResult {
  readonly requeued: number;
  readonly failed: number;
}

/** Ссылка на захваченную запись (см. модель владения в шапке файла). */
export interface NotificationClaimRef {
  readonly id: string;
  readonly attempts: number;
  readonly at: Date;
}

export interface MarkRetryParams extends NotificationClaimRef {
  readonly nextAttemptAt: Date;
  /** Уже очищенная от секретов и усечённая причина. */
  readonly error: string;
}

export interface MarkFailedParams extends NotificationClaimRef {
  readonly error: string;
}

export interface MarkBotBlockedParams extends NotificationClaimRef {
  readonly userId: string;
}

export interface NotificationOutboxRepository {
  /**
   * Атомарно захватывает созревшие PENDING-записи (PENDING → PROCESSING, attempts + 1).
   * Параллельные вызовы не получают одну и ту же запись.
   */
  claimDue(params: ClaimDueNotificationsParams): Promise<ClaimedNotification[]>;

  /** Возвращает зависшие PROCESSING-записи в очередь (или в FAILED, если попытки исчерпаны). */
  releaseStale(params: ReleaseStaleParams): Promise<ReleaseStaleResult>;

  markSent(ref: NotificationClaimRef): Promise<boolean>;

  /** PROCESSING → PENDING с отложенной следующей попыткой. */
  markRetry(params: MarkRetryParams): Promise<boolean>;

  /** PROCESSING → FAILED без повторов. */
  markFailed(params: MarkFailedParams): Promise<boolean>;

  /** PROCESSING → FAILED и User.botBlockedAt = at, одной транзакцией. */
  markBotBlocked(params: MarkBotBlockedParams): Promise<boolean>;
}
