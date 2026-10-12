/**
 * Unit-тесты NotificationService с in-memory репозиторием и фейковым sender.
 * Поведение настоящего репозитория проверяют интеграционные тесты tests/db.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EXCHANGE_STATUS_CHANGED } from '../../src/application/notifications/exchange-status-notification.js';
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
} from '../../src/application/notifications/notification-repository.js';
import {
  NotificationSendError,
  type NotificationSender,
} from '../../src/application/notifications/notification-sender.js';
import { NotificationService } from '../../src/application/notifications/notification-service.js';
import { createLogger } from '../../src/observability/logger.js';

const START = new Date('2026-01-01T00:00:00.000Z');
const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });

const validPayload = {
  exchangeId: '0198a2c4-7b1e-7c3a-9d2f-3b5a6c7d8e9f',
  fromStatus: 'WAITING_DEPOSIT',
  toStatus: 'CONFIRMING',
  fromCurrency: 'usdt',
  toCurrency: 'btc',
};

type Marked =
  | { kind: 'sent' }
  | { kind: 'retry'; nextAttemptAt: Date; error: string }
  | { kind: 'failed'; error: string }
  | { kind: 'blocked' };

class FakeRepository implements NotificationOutboxRepository {
  claimable: ClaimedNotification[] = [];
  marks = new Map<string, Marked>();
  released: ReleaseStaleResult = { requeued: 0, failed: 0 };
  releaseParams: ReleaseStaleParams | undefined;
  /** id записей, у которых «владение» потеряно (метод mark* вернёт false). */
  lost = new Set<string>();
  failOnMark = false;

  claimDue(params: ClaimDueNotificationsParams): Promise<ClaimedNotification[]> {
    return Promise.resolve(this.claimable.splice(0, params.limit));
  }

  releaseStale(params: ReleaseStaleParams): Promise<ReleaseStaleResult> {
    this.releaseParams = params;
    return Promise.resolve(this.released);
  }

  markSent(ref: NotificationClaimRef): Promise<boolean> {
    return this.record(ref.id, { kind: 'sent' });
  }

  markRetry(params: MarkRetryParams): Promise<boolean> {
    return this.record(params.id, {
      kind: 'retry',
      nextAttemptAt: params.nextAttemptAt,
      error: params.error,
    });
  }

  markFailed(params: MarkFailedParams): Promise<boolean> {
    return this.record(params.id, { kind: 'failed', error: params.error });
  }

  markBotBlocked(params: MarkBotBlockedParams): Promise<boolean> {
    return this.record(params.id, { kind: 'blocked' });
  }

  private record(id: string, mark: Marked): Promise<boolean> {
    if (this.failOnMark) return Promise.reject(new Error('db down'));
    if (this.lost.has(id)) return Promise.resolve(false);
    this.marks.set(id, mark);
    return Promise.resolve(true);
  }
}

function claimed(id: string, overrides: Partial<ClaimedNotification> = {}): ClaimedNotification {
  return {
    id,
    userId: 'user-1',
    exchangeId: validPayload.exchangeId,
    type: EXCHANGE_STATUS_CHANGED,
    payload: validPayload,
    attempts: 1,
    telegramId: 42n,
    botBlockedAt: null,
    ...overrides,
  };
}

describe('NotificationService', () => {
  let repository: FakeRepository;
  let send: ReturnType<typeof vi.fn<NotificationSender['send']>>;
  let sleep: ReturnType<typeof vi.fn<(ms: number) => Promise<void>>>;
  let service: NotificationService;

  beforeEach(() => {
    repository = new FakeRepository();
    send = vi.fn<NotificationSender['send']>(() => Promise.resolve());
    sleep = vi.fn<(ms: number) => Promise<void>>(() => Promise.resolve());
    service = new NotificationService({
      repository,
      sender: { send },
      logger,
      now: () => START,
      sleep,
      config: {
        maxAttempts: 3,
        lockTtlMs: 60_000,
        retryBackoffBaseMs: 1000,
        minSendIntervalMs: 50,
      },
    });
  });

  it('доставляет уведомление и помечает его отправленным', async () => {
    repository.claimable = [claimed('n1')];

    const summary = await service.dispatchDue(10);

    expect(summary).toMatchObject({ claimed: 1, sent: 1, retried: 0, failed: 0 });
    expect(repository.marks.get('n1')).toEqual({ kind: 'sent' });
    expect(send).toHaveBeenCalledWith(
      {
        chatId: 42n,
        text: [
          '💳 Обмен USDT → BTC',
          '',
          `Заявка: ${validPayload.exchangeId.slice(-8)}`,
          '',
          'Видим ваш платёж.',
          'Средства будут зачислены в течение короткого времени.',
        ].join('\n'),
      },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
  });

  it('после финала отправляет вторым сообщением квитанцию и не кладёт её в outbox', async () => {
    repository.claimable = [claimed('n1', { payload: { ...validPayload, toStatus: 'FINISHED' } })];
    const followUp = vi.fn(() => Promise.resolve({ text: '<b>Квитанция</b>', html: true }));
    service = new NotificationService({
      repository,
      sender: { send },
      logger,
      now: () => START,
      sleep,
      followUp,
      config: { minSendIntervalMs: 0 },
    });

    await service.dispatchDue(10);

    expect(followUp).toHaveBeenCalledOnce();
    expect(send).toHaveBeenNthCalledWith(
      2,
      { chatId: 42n, text: '<b>Квитанция</b>', html: true },
      { signal: expect.any(AbortSignal) as AbortSignal },
    );
    expect(repository.marks.get('n1')).toEqual({ kind: 'sent' });
    expect(JSON.stringify(repository.claimable)).not.toContain('Квитанция');
  });

  it('освобождает зависшие записи с учётом lock TTL и лимита попыток', async () => {
    repository.released = { requeued: 2, failed: 1 };

    const summary = await service.dispatchDue(10);

    expect(summary).toMatchObject({ requeued: 2, expired: 1, claimed: 0 });
    expect(repository.releaseParams).toEqual({
      now: START,
      lockedBefore: new Date(START.getTime() - 60_000),
      maxAttempts: 3,
    });
  });

  it('делает паузу между отправками, но не перед первой', async () => {
    repository.claimable = [claimed('n1'), claimed('n2'), claimed('n3')];

    await service.dispatchDue(10);

    expect(send).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(50);
  });

  describe('временные ошибки', () => {
    it('откладывает повтор с экспоненциальным backoff', async () => {
      repository.claimable = [claimed('n1', { attempts: 1 }), claimed('n2', { attempts: 2 })];
      send.mockRejectedValue(new NotificationSendError('TRANSIENT', 'network', 'socket hang up'));

      const summary = await service.dispatchDue(10);

      expect(summary).toMatchObject({ retried: 2, sent: 0, failed: 0 });
      expect(repository.marks.get('n1')).toMatchObject({
        kind: 'retry',
        nextAttemptAt: new Date(START.getTime() + 1000),
      });
      expect(repository.marks.get('n2')).toMatchObject({
        kind: 'retry',
        nextAttemptAt: new Date(START.getTime() + 2000),
      });
    });

    it('учитывает retry_after, если он больше backoff', async () => {
      repository.claimable = [claimed('n1')];
      send.mockRejectedValue(
        new NotificationSendError('TRANSIENT', 'telegram_429', 'Too Many Requests', 30_000),
      );

      await service.dispatchDue(10);

      expect(repository.marks.get('n1')).toMatchObject({
        kind: 'retry',
        nextAttemptAt: new Date(START.getTime() + 30_000),
      });
    });

    it('неизвестная ошибка sender тоже трактуется как временная', async () => {
      repository.claimable = [claimed('n1')];
      send.mockRejectedValue(new Error('boom'));

      const summary = await service.dispatchDue(10);

      expect(summary.retried).toBe(1);
      expect(repository.marks.get('n1')).toMatchObject({ kind: 'retry', error: 'boom' });
    });

    it('после исчерпания попыток переводит запись в FAILED', async () => {
      repository.claimable = [claimed('n1', { attempts: 3 })];
      send.mockRejectedValue(new NotificationSendError('TRANSIENT', 'network', 'down'));

      const summary = await service.dispatchDue(10);

      expect(summary).toMatchObject({ failed: 1, retried: 0 });
      expect(repository.marks.get('n1')).toMatchObject({ kind: 'failed' });
    });

    it('не сохраняет токен бота из текста ошибки', async () => {
      repository.claimable = [claimed('n1')];
      const token = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
      send.mockRejectedValue(new Error(`GET https://api.telegram.org/bot${token}/sendMessage`));

      await service.dispatchDue(10);

      const mark = repository.marks.get('n1');
      expect(mark).toMatchObject({ kind: 'retry' });
      expect(JSON.stringify(mark)).not.toContain('AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0');
    });
  });

  describe('окончательные отказы', () => {
    it('PERMANENT: сразу FAILED, без повторов', async () => {
      repository.claimable = [claimed('n1')];
      send.mockRejectedValue(
        new NotificationSendError('PERMANENT', 'chat_not_found', 'chat not found'),
      );

      const summary = await service.dispatchDue(10);

      expect(summary.failed).toBe(1);
      expect(repository.marks.get('n1')).toMatchObject({
        kind: 'failed',
        error: 'chat_not_found: chat not found',
      });
    });

    it('BOT_BLOCKED: фиксирует блокировку бота', async () => {
      repository.claimable = [claimed('n1')];
      send.mockRejectedValue(new NotificationSendError('BOT_BLOCKED', 'telegram_403', 'blocked'));

      const summary = await service.dispatchDue(10);

      expect(summary.failed).toBe(1);
      expect(repository.marks.get('n1')).toEqual({ kind: 'blocked' });
    });

    it('не отправляет сообщение пользователю, который уже заблокировал бота', async () => {
      repository.claimable = [claimed('n1', { botBlockedAt: START })];

      const summary = await service.dispatchDue(10);

      expect(send).not.toHaveBeenCalled();
      expect(summary.failed).toBe(1);
      expect(repository.marks.get('n1')).toEqual({ kind: 'failed', error: 'bot_blocked' });
    });

    it.each([
      ['неизвестный тип', { type: 'UNKNOWN' }, 'unknown_type'],
      ['битый payload', { payload: { toStatus: 'FINISHED' } }, 'invalid_payload'],
    ])('%s: FAILED без отправки', async (_name, overrides, code) => {
      repository.claimable = [claimed('n1', overrides)];

      const summary = await service.dispatchDue(10);

      expect(send).not.toHaveBeenCalled();
      expect(summary.failed).toBe(1);
      expect(repository.marks.get('n1')).toEqual({ kind: 'failed', error: code });
    });
  });

  describe('надёжность', () => {
    it('ошибка одной записи не мешает остальным', async () => {
      repository.claimable = [claimed('n1'), claimed('n2')];
      send.mockRejectedValueOnce(new NotificationSendError('PERMANENT', 'x', 'nope'));

      const summary = await service.dispatchDue(10);

      expect(summary).toMatchObject({ claimed: 2, failed: 1, sent: 1 });
    });

    it('перехваченная запись не считается доставленной', async () => {
      repository.claimable = [claimed('n1')];
      repository.lost.add('n1');

      const summary = await service.dispatchDue(10);

      expect(summary).toMatchObject({ lost: 1, sent: 0 });
    });

    it('сбой БД при фиксации результата не обрывает проход', async () => {
      repository.claimable = [claimed('n1'), claimed('n2')];
      repository.failOnMark = true;

      const summary = await service.dispatchDue(10);

      expect(send).toHaveBeenCalledTimes(2);
      expect(summary).toMatchObject({ claimed: 2, errors: 2, sent: 0 });
    });

    it('соблюдает лимит пакета', async () => {
      repository.claimable = [claimed('n1'), claimed('n2'), claimed('n3')];

      const summary = await service.dispatchDue(2);

      expect(summary.claimed).toBe(2);
      expect(send).toHaveBeenCalledTimes(2);
    });
  });
});
