import type {
  ClaimDueNotificationsParams,
  ClaimedNotification,
  MarkBotBlockedParams,
  MarkFailedParams,
  MarkRetryParams,
  NotificationClaimRef,
  NotificationOutboxRepository,
  ReleaseStaleParams,
  ReleaseStaleResult,
} from '../../application/notifications/notification-repository.js';
import type { PrismaClient } from '../prisma.js';

interface ClaimedRow {
  id: string;
  user_id: string;
  exchange_id: string | null;
  type: string;
  payload: unknown;
  attempts: number;
}

export class PrismaNotificationOutboxRepository implements NotificationOutboxRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async claimDue(params: ClaimDueNotificationsParams): Promise<ClaimedNotification[]> {
    if (params.limit <= 0) return [];
    // SKIP LOCKED: параллельные worker не ждут друг друга и не получают одну запись.
    // Все значения передаются параметрами.
    const rows = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE notification_outbox
      SET status = 'PROCESSING',
          locked_at = ${params.now}::timestamptz,
          attempts = attempts + 1,
          updated_at = ${params.now}::timestamptz
      WHERE id IN (
        SELECT id FROM notification_outbox
        WHERE status = 'PENDING'
          AND next_attempt_at <= ${params.now}::timestamptz
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT ${params.limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id,
                user_id::text AS user_id,
                exchange_id::text AS exchange_id,
                type,
                payload,
                attempts`;
    if (rows.length === 0) return [];

    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(rows.map((row) => row.user_id))] } },
      select: { id: true, telegramId: true, botBlockedAt: true },
    });
    const byId = new Map(users.map((user) => [user.id, user]));

    return rows.flatMap((row) => {
      const user = byId.get(row.user_id);
      // Внешний ключ RESTRICT: пользователь существует всегда.
      if (!user) throw new Error('Invariant violated: notification user is missing');
      return [
        {
          id: row.id,
          userId: row.user_id,
          exchangeId: row.exchange_id,
          type: row.type,
          payload: row.payload,
          attempts: row.attempts,
          telegramId: user.telegramId,
          botBlockedAt: user.botBlockedAt,
        },
      ];
    });
  }

  async releaseStale(params: ReleaseStaleParams): Promise<ReleaseStaleResult> {
    const stale = {
      status: 'PROCESSING',
      lockedAt: { lte: params.lockedBefore },
    } as const;
    return this.prisma.$transaction(async (tx) => {
      const failed = await tx.notificationOutbox.updateMany({
        where: { ...stale, attempts: { gte: params.maxAttempts } },
        data: { status: 'FAILED', lockedAt: null, lastError: 'lock_expired_attempts_exhausted' },
      });
      const requeued = await tx.notificationOutbox.updateMany({
        where: { ...stale, attempts: { lt: params.maxAttempts } },
        data: {
          status: 'PENDING',
          lockedAt: null,
          nextAttemptAt: params.now,
          lastError: 'lock_expired',
        },
      });
      return { requeued: requeued.count, failed: failed.count };
    });
  }

  async markSent(ref: NotificationClaimRef): Promise<boolean> {
    return this.updateOwned(ref, {
      status: 'SENT',
      sentAt: ref.at,
      lockedAt: null,
      lastError: null,
    });
  }

  async markRetry(params: MarkRetryParams): Promise<boolean> {
    return this.updateOwned(params, {
      status: 'PENDING',
      lockedAt: null,
      nextAttemptAt: params.nextAttemptAt,
      lastError: params.error,
    });
  }

  async markFailed(params: MarkFailedParams): Promise<boolean> {
    return this.updateOwned(params, {
      status: 'FAILED',
      lockedAt: null,
      lastError: params.error,
    });
  }

  async markBotBlocked(params: MarkBotBlockedParams): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.notificationOutbox.updateMany({
        where: { id: params.id, status: 'PROCESSING', attempts: params.attempts },
        data: { status: 'FAILED', lockedAt: null, lastError: 'bot_blocked' },
      });
      if (result.count === 0) return false;
      await tx.user.update({
        where: { id: params.userId },
        data: { botBlockedAt: params.at },
      });
      return true;
    });
  }

  /** Обновление, применяемое только владельцу текущего захвата (id + attempts). */
  private async updateOwned(
    ref: NotificationClaimRef,
    data: Parameters<PrismaClient['notificationOutbox']['updateMany']>[0]['data'],
  ): Promise<boolean> {
    const result = await this.prisma.notificationOutbox.updateMany({
      where: { id: ref.id, status: 'PROCESSING', attempts: ref.attempts },
      data,
    });
    return result.count > 0;
  }
}
