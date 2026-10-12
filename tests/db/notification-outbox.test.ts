/**
 * Интеграционные тесты outbox уведомлений: реальная БД, MockExchangeProvider и
 * фейковый sender (нужна TEST_DATABASE_URL). Сети и Telegram здесь нет.
 *
 * Данные между тестами не очищаются, а тестовые файлы работают с одной БД параллельно,
 * поэтому строки этого файла создаются с «древним» nextAttemptAt (раньше любых
 * чужих записей) и в beforeEach удаляются остатки прошлых запусков.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeService } from '../../src/application/exchanges/exchange-service.js';
import { EXCHANGE_STATUS_CHANGED } from '../../src/application/notifications/exchange-status-notification.js';
import type { NotificationSender } from '../../src/application/notifications/notification-sender.js';
import { NotificationService } from '../../src/application/notifications/notification-service.js';
import type { Prisma } from '../../src/database/generated/client.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import { PrismaExchangeRepository } from '../../src/database/repositories/prisma-exchange-repository.js';
import { PrismaNotificationOutboxRepository } from '../../src/database/repositories/prisma-notification-outbox-repository.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';
import { createLogger } from '../../src/observability/logger.js';
import { createTestUser, setupTestDatabase, testDatabaseUrl } from './test-database.js';

const START = new Date('2026-01-01T00:00:00.000Z');
const ANCIENT = new Date('1990-01-01T00:00:00.000Z');
const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });

describe.skipIf(!testDatabaseUrl)('NotificationOutbox', () => {
  let prisma: PrismaClient;
  let repository: PrismaNotificationOutboxRepository;

  beforeAll(() => {
    prisma = setupTestDatabase();
    repository = new PrismaNotificationOutboxRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await prisma.notificationOutbox.deleteMany({ where: { nextAttemptAt: { lt: START } } });
  });

  const payload = {
    exchangeId: '0198a2c4-7b1e-7c3a-9d2f-3b5a6c7d8e9f',
    fromStatus: 'WAITING_DEPOSIT',
    toStatus: 'CONFIRMING',
    fromCurrency: 'usdt',
    toCurrency: 'btc',
  };

  function addRow(
    userId: string,
    overrides: Partial<Prisma.NotificationOutboxUncheckedCreateInput> = {},
  ) {
    return prisma.notificationOutbox.create({
      data: {
        userId,
        type: EXCHANGE_STATUS_CHANGED,
        payload,
        dedupeKey: randomUUID(),
        nextAttemptAt: ANCIENT,
        ...overrides,
      },
    });
  }

  const reload = (id: string) => prisma.notificationOutbox.findUniqueOrThrow({ where: { id } });

  describe('claimDue', () => {
    it('захватывает созревшие PENDING-записи: PROCESSING, attempts + 1, данные получателя', async () => {
      const { id } = await createTestUser(prisma);
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      const due = await addRow(user.id);
      const future = await addRow(user.id, { nextAttemptAt: new Date('2099-01-01T00:00:00Z') });
      const sent = await addRow(user.id, { status: 'SENT', sentAt: START });
      const failed = await addRow(user.id, { status: 'FAILED' });

      const claimed = await repository.claimDue({ now: START, limit: 100 });
      const mine = claimed.filter((c) => c.userId === user.id);

      expect(mine).toHaveLength(1);
      expect(mine[0]).toMatchObject({
        id: due.id,
        attempts: 1,
        type: EXCHANGE_STATUS_CHANGED,
        payload,
        telegramId: user.telegramId,
        botBlockedAt: null,
      });
      const row = await reload(due.id);
      expect(row).toMatchObject({ status: 'PROCESSING', attempts: 1, lockedAt: START });
      expect((await reload(future.id)).status).toBe('PENDING');
      expect((await reload(sent.id)).status).toBe('SENT');
      expect((await reload(failed.id)).status).toBe('FAILED');

      // Повторный захват ничего не возвращает: запись уже PROCESSING.
      const again = await repository.claimDue({ now: START, limit: 100 });
      expect(again.filter((c) => c.userId === user.id)).toHaveLength(0);
    });

    it('соблюдает limit: берёт самые старые записи (порядок RETURNING не гарантируется)', async () => {
      const user = await createTestUser(prisma);
      const second = await addRow(user.id, { nextAttemptAt: new Date('1990-01-02T00:00:00Z') });
      const first = await addRow(user.id, { nextAttemptAt: new Date('1990-01-01T00:00:00Z') });
      const third = await addRow(user.id, { nextAttemptAt: new Date('1990-01-03T00:00:00Z') });

      const claimed = await repository.claimDue({ now: START, limit: 2 });

      expect(
        claimed
          .map((c) => c.id)
          .filter((id) => [first.id, second.id, third.id].includes(id))
          .sort(),
      ).toEqual([first.id, second.id].sort());
      expect((await reload(third.id)).status).toBe('PENDING');
    });

    it('параллельные захваты не получают одну запись дважды', async () => {
      const user = await createTestUser(prisma);
      const rows = await Promise.all(Array.from({ length: 12 }, () => addRow(user.id)));

      const batches = await Promise.all([
        repository.claimDue({ now: START, limit: 5 }),
        repository.claimDue({ now: START, limit: 5 }),
        repository.claimDue({ now: START, limit: 5 }),
        repository.claimDue({ now: START, limit: 5 }),
      ]);

      const ids = batches.flat().map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
      const mine = ids.filter((id) => rows.some((r) => r.id === id));
      expect(mine).toHaveLength(12);
    });

    it('передаёт botBlockedAt получателя', async () => {
      const user = await createTestUser(prisma);
      await prisma.user.update({ where: { id: user.id }, data: { botBlockedAt: START } });
      await addRow(user.id);

      const claimed = await repository.claimDue({ now: START, limit: 100 });

      expect(claimed.find((c) => c.userId === user.id)?.botBlockedAt).toEqual(START);
    });
  });

  describe('releaseStale', () => {
    it('возвращает зависшие записи в очередь или закрывает при исчерпании попыток', async () => {
      const user = await createTestUser(prisma);
      const lockedAt = new Date(START.getTime() - 10 * 60_000);
      const stale = await addRow(user.id, { status: 'PROCESSING', lockedAt, attempts: 1 });
      const exhausted = await addRow(user.id, { status: 'PROCESSING', lockedAt, attempts: 3 });
      const fresh = await addRow(user.id, {
        status: 'PROCESSING',
        lockedAt: new Date(START.getTime() - 1000),
        attempts: 1,
      });

      const result = await repository.releaseStale({
        now: START,
        lockedBefore: new Date(START.getTime() - 5 * 60_000),
        maxAttempts: 3,
      });

      expect(result.requeued).toBeGreaterThanOrEqual(1);
      expect(result.failed).toBeGreaterThanOrEqual(1);
      expect(await reload(stale.id)).toMatchObject({
        status: 'PENDING',
        lockedAt: null,
        nextAttemptAt: START,
        lastError: 'lock_expired',
        attempts: 1,
      });
      expect(await reload(exhausted.id)).toMatchObject({
        status: 'FAILED',
        lockedAt: null,
        lastError: 'lock_expired_attempts_exhausted',
      });
      expect(await reload(fresh.id)).toMatchObject({ status: 'PROCESSING' });
    });
  });

  describe('фиксация результата', () => {
    async function claimOne(userId: string) {
      const row = await addRow(userId);
      const claimed = await repository.claimDue({ now: START, limit: 100 });
      const mine = claimed.find((c) => c.id === row.id);
      if (!mine) throw new Error('row was not claimed');
      return mine;
    }

    it('markSent: SENT, sentAt, lock снят; повторный вызов не применяется', async () => {
      const user = await createTestUser(prisma);
      const n = await claimOne(user.id);
      const at = new Date(START.getTime() + 5000);

      expect(await repository.markSent({ id: n.id, attempts: n.attempts, at })).toBe(true);
      expect(await reload(n.id)).toMatchObject({
        status: 'SENT',
        sentAt: at,
        lockedAt: null,
        lastError: null,
      });
      expect(await repository.markSent({ id: n.id, attempts: n.attempts, at })).toBe(false);
    });

    it('markRetry: PENDING с отложенной попыткой, запись снова захватывается только после срока', async () => {
      const user = await createTestUser(prisma);
      const n = await claimOne(user.id);
      const retryAt = new Date(START.getTime() + 60_000);

      expect(
        await repository.markRetry({
          id: n.id,
          attempts: n.attempts,
          at: START,
          nextAttemptAt: retryAt,
          error: 'network: timeout',
        }),
      ).toBe(true);
      expect(await reload(n.id)).toMatchObject({
        status: 'PENDING',
        lockedAt: null,
        nextAttemptAt: retryAt,
        lastError: 'network: timeout',
        attempts: 1,
      });

      const early = await repository.claimDue({ now: START, limit: 100 });
      expect(early.find((c) => c.id === n.id)).toBeUndefined();
      const later = await repository.claimDue({ now: retryAt, limit: 100 });
      expect(later.find((c) => c.id === n.id)?.attempts).toBe(2);
    });

    it('markFailed: FAILED без повторов', async () => {
      const user = await createTestUser(prisma);
      const n = await claimOne(user.id);

      expect(
        await repository.markFailed({
          id: n.id,
          attempts: n.attempts,
          at: START,
          error: 'chat_not_found',
        }),
      ).toBe(true);
      expect(await reload(n.id)).toMatchObject({
        status: 'FAILED',
        lockedAt: null,
        lastError: 'chat_not_found',
      });
    });

    it('markBotBlocked: FAILED и User.botBlockedAt одной операцией', async () => {
      const user = await createTestUser(prisma);
      const n = await claimOne(user.id);
      const at = new Date(START.getTime() + 1000);

      expect(
        await repository.markBotBlocked({ id: n.id, attempts: n.attempts, at, userId: user.id }),
      ).toBe(true);

      expect(await reload(n.id)).toMatchObject({ status: 'FAILED', lastError: 'bot_blocked' });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).botBlockedAt,
      ).toEqual(at);
    });

    it('результат перехваченной записи игнорируется (защита от гонки после lock TTL)', async () => {
      const user = await createTestUser(prisma);
      const first = await claimOne(user.id);

      // Первый исполнитель завис: запись возвращена в очередь и захвачена вторым.
      await repository.releaseStale({
        now: START,
        lockedBefore: new Date(START.getTime() + 1),
        maxAttempts: 10,
      });
      const second = (await repository.claimDue({ now: START, limit: 100 })).find(
        (c) => c.id === first.id,
      );
      expect(second?.attempts).toBe(2);

      // Опоздавший первый исполнитель ничего не меняет, включая пользователя.
      const late = { id: first.id, attempts: first.attempts, at: START };
      expect(await repository.markSent(late)).toBe(false);
      expect(await repository.markRetry({ ...late, nextAttemptAt: START, error: 'x' })).toBe(false);
      expect(await repository.markFailed({ ...late, error: 'x' })).toBe(false);
      expect(await repository.markBotBlocked({ ...late, userId: user.id })).toBe(false);
      expect(await reload(first.id)).toMatchObject({ status: 'PROCESSING', attempts: 2 });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).botBlockedAt,
      ).toBeNull();

      expect(await repository.markSent({ id: first.id, attempts: 2, at: START })).toBe(true);
    });
  });

  it('dedupeKey уникален', async () => {
    const user = await createTestUser(prisma);
    const key = randomUUID();
    await addRow(user.id, { dedupeKey: key });

    await expect(addRow(user.id, { dedupeKey: key })).rejects.toMatchObject({ code: 'P2002' });
  });

  describe('постановка в очередь при смене статуса обмена', () => {
    let now: Date;
    let provider: MockExchangeProvider;
    let exchanges: ExchangeService;

    beforeEach(() => {
      now = START;
      provider = new MockExchangeProvider({ now: () => now });
      exchanges = new ExchangeService({
        repository: new PrismaExchangeRepository(prisma),
        provider,
        providerKind: 'MOCK',
        logger,
        now: () => now,
      });
    });

    async function waitingDeposit(userId: string) {
      const draft = await exchanges.createDraft({
        userId,
        clientRequestId: randomUUID(),
        fromCurrency: 'usdt',
        fromNetwork: 'trx',
        toCurrency: 'btc',
        toNetwork: 'btc',
        fromAmount: '100',
        rateType: 'FLOATING',
        payoutAddress: 'test-payout-address',
        refundAddress: 'test-refund-address',
      });
      await exchanges.requestQuote(userId, draft.id);
      await exchanges.requestConfirmation(userId, draft.id);
      return exchanges.confirmAndCreate(userId, draft.id);
    }

    const outboxOf = (exchangeId: string) =>
      prisma.notificationOutbox.findMany({ where: { exchangeId }, orderBy: { createdAt: 'asc' } });

    it('действия пользователя в диалоге уведомлений не создают', async () => {
      const user = await createTestUser(prisma);

      const exchange = await waitingDeposit(user.id);

      expect(await outboxOf(exchange.id)).toHaveLength(0);
    });

    it('переход от провайдера пишет уведомление атомарно с историей, без секретов', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const providerExchangeId = exchange.providerExchangeId ?? '';

      provider.advanceStatus(providerExchangeId);
      const result = await exchanges.syncWithProvider(exchange.id);
      expect(result.exchange.status).toBe('CONFIRMING');

      const rows = await outboxOf(exchange.id);
      expect(rows).toHaveLength(1);
      const history = await prisma.exchangeStatusHistory.findFirstOrThrow({
        where: { exchangeId: exchange.id, toStatus: 'CONFIRMING' },
      });
      expect(rows[0]).toMatchObject({
        userId: user.id,
        type: EXCHANGE_STATUS_CHANGED,
        status: 'PENDING',
        attempts: 0,
        nextAttemptAt: START,
        dedupeKey: `exchange:${exchange.id}:history:${history.id}`,
        payload: {
          exchangeId: exchange.id,
          fromStatus: 'WAITING_DEPOSIT',
          toStatus: 'CONFIRMING',
          fromCurrency: 'usdt',
          toCurrency: 'btc',
        },
      });
      const serialized = JSON.stringify(rows[0]?.payload);
      expect(serialized).not.toContain('test-payout-address');
      expect(serialized).not.toContain('test-refund-address');
      expect(serialized).not.toContain(result.exchange.payinAddress ?? 'no-payin');
    });

    it('повторная проверка не создаёт уведомление, промежуточный статус тоже', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const providerExchangeId = exchange.providerExchangeId ?? '';

      await exchanges.syncWithProvider(exchange.id);
      expect(await outboxOf(exchange.id)).toHaveLength(0);

      provider.advanceStatus(providerExchangeId);
      await exchanges.syncWithProvider(exchange.id);
      await exchanges.syncWithProvider(exchange.id);
      provider.advanceStatus(providerExchangeId);
      await exchanges.syncWithProvider(exchange.id);

      const rows = await outboxOf(exchange.id);
      expect(rows.map((r) => (r.payload as { toStatus: string }).toStatus)).toEqual(['CONFIRMING']);
    });

    it('сквозной сценарий: переход → outbox → NotificationService → SENT', async () => {
      const { id } = await createTestUser(prisma);
      const user = await prisma.user.findUniqueOrThrow({ where: { id } });
      const exchange = await waitingDeposit(user.id);
      provider.advanceStatus(exchange.providerExchangeId ?? '');
      await exchanges.syncWithProvider(exchange.id);

      const send = vi.fn<NotificationSender['send']>(() => Promise.resolve());
      const notifications = new NotificationService({
        repository,
        sender: { send },
        logger,
        now: () => START,
        config: { minSendIntervalMs: 0 },
      });

      // В общей БД могут быть чужие записи: проверяем именно свою.
      await notifications.dispatchDue(1000);

      const calls = send.mock.calls.filter(([message]) => message.chatId === user.telegramId);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.[0].text).toBe(
        [
          '💳 Обмен USDT → BTC',
          '',
          `Заявка: ${exchange.id.slice(-8)}`,
          '',
          'Видим ваш платёж.',
          'Средства будут зачислены в течение короткого времени.',
        ].join('\n'),
      );
      const [row] = await outboxOf(exchange.id);
      expect(row).toMatchObject({ status: 'SENT', attempts: 1, sentAt: START });
    });
  });
});
