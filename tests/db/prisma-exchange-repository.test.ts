/**
 * Интеграционные тесты PrismaExchangeRepository (нужна TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ExchangeNotFoundError,
  ExchangeStatusConflictError,
} from '../../src/application/exchanges/errors.js';
import type { NewDraft } from '../../src/application/exchanges/exchange-repository.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import { PrismaExchangeRepository } from '../../src/database/repositories/prisma-exchange-repository.js';
import { createTestUser, setupTestDatabase, testDatabaseUrl } from './test-database.js';

const at = new Date('2026-01-01T00:00:00.000Z');
const later = new Date('2026-01-01T01:00:00.000Z');

function newDraft(userId: string, overrides: Partial<NewDraft> = {}): NewDraft {
  return {
    userId,
    provider: 'MOCK',
    idempotencyKey: randomUUID(),
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    expectedFromAmount: '100.5',
    payoutAddress: 'test-payout-address',
    payoutExtraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateType: 'FLOATING',
    nextCheckAt: later,
    ...overrides,
  };
}

describe.skipIf(!testDatabaseUrl)('PrismaExchangeRepository', () => {
  let prisma: PrismaClient;
  let repository: PrismaExchangeRepository;

  beforeAll(() => {
    prisma = setupTestDatabase();
    repository = new PrismaExchangeRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const history = (exchangeId: string) =>
    prisma.exchangeStatusHistory.findMany({ where: { exchangeId }, orderBy: { sequence: 'asc' } });

  describe('createDraft', () => {
    it('создаёт обмен и первую запись истории', async () => {
      const user = await createTestUser(prisma);
      const { exchange, created } = await repository.createDraft(newDraft(user.id));

      expect(created).toBe(true);
      expect(exchange.status).toBe('DRAFT');
      expect(exchange.expectedFromAmount).toBe('100.5');
      expect(exchange.nextCheckAt).toEqual(later);

      const rows = await history(exchange.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sequence: 1,
        fromStatus: null,
        toStatus: 'DRAFT',
        reason: 'draft_created',
      });
    });

    it('возвращает существующий обмен для повторного ключа без второй истории', async () => {
      const user = await createTestUser(prisma);
      const draft = newDraft(user.id);
      const first = await repository.createDraft(draft);
      const second = await repository.createDraft(draft);

      expect(second.created).toBe(false);
      expect(second.exchange.id).toBe(first.exchange.id);
      expect(await history(first.exchange.id)).toHaveLength(1);
    });

    it('параллельные запросы с одним ключом создают ровно один обмен', async () => {
      const user = await createTestUser(prisma);
      const draft = newDraft(user.id);
      const results = await Promise.all(
        Array.from({ length: 5 }, () => repository.createDraft(draft)),
      );

      expect(new Set(results.map((r) => r.exchange.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
    });

    it('точно хранит суммы с малыми значениями (без экспоненты)', async () => {
      const user = await createTestUser(prisma);
      const { exchange } = await repository.createDraft(
        newDraft(user.id, { expectedFromAmount: '0.000000000000000001' }),
      );
      expect(exchange.expectedFromAmount).toBe('0.000000000000000001');
    });
  });

  describe('transition', () => {
    it('меняет статус, пишет историю и применяет патч', async () => {
      const user = await createTestUser(prisma);
      const { exchange } = await repository.createDraft(newDraft(user.id));

      const quoted = await repository.transition({
        exchangeId: exchange.id,
        from: 'DRAFT',
        to: 'QUOTED',
        reason: 'quote_obtained',
        at,
        nextCheckAt: later,
        patch: { expectedToAmount: '0.001608', quoteExpiresAt: later, providerRateId: null },
      });

      expect(quoted.status).toBe('QUOTED');
      expect(quoted.statusChangedAt).toEqual(at);
      expect(quoted.expectedToAmount).toBe('0.001608');
      expect(quoted.quoteExpiresAt).toEqual(later);

      const rows = await history(exchange.id);
      expect(rows.map((r) => [r.sequence, r.fromStatus, r.toStatus, r.reason])).toEqual([
        [1, null, 'DRAFT', 'draft_created'],
        [2, 'DRAFT', 'QUOTED', 'quote_obtained'],
      ]);
    });

    it('при несовпадении статуса бросает конфликт и ничего не меняет', async () => {
      const user = await createTestUser(prisma);
      const { exchange } = await repository.createDraft(newDraft(user.id));

      await expect(
        repository.transition({
          exchangeId: exchange.id,
          from: 'QUOTED',
          to: 'AWAITING_CONFIRMATION',
          reason: 'x',
          at,
          nextCheckAt: later,
        }),
      ).rejects.toThrow(ExchangeStatusConflictError);

      expect((await repository.findById(exchange.id))?.status).toBe('DRAFT');
      expect(await history(exchange.id)).toHaveLength(1);
    });

    it('бросает ExchangeNotFoundError для неизвестного обмена', async () => {
      await expect(
        repository.transition({
          exchangeId: randomUUID(),
          from: 'DRAFT',
          to: 'EXPIRED',
          reason: 'x',
          at,
          nextCheckAt: null,
        }),
      ).rejects.toThrow(ExchangeNotFoundError);
    });

    it('из параллельных одинаковых переходов выигрывает ровно один', async () => {
      const user = await createTestUser(prisma);
      const { exchange } = await repository.createDraft(newDraft(user.id));

      const attempts = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          repository.transition({
            exchangeId: exchange.id,
            from: 'DRAFT',
            to: 'EXPIRED',
            reason: 'draft_expired',
            at,
            nextCheckAt: null,
          }),
        ),
      );

      expect(attempts.filter((a) => a.status === 'fulfilled')).toHaveLength(1);
      const failures = attempts.filter((a) => a.status === 'rejected');
      expect(failures).toHaveLength(4);
      for (const failure of failures) {
        expect(failure.reason).toBeInstanceOf(ExchangeStatusConflictError);
      }
      expect(await history(exchange.id)).toHaveLength(2);
    });

    it('откатывает переход, если БД отвергла данные (CHECK), история не пишется', async () => {
      const user = await createTestUser(prisma);
      const { exchange } = await repository.createDraft(newDraft(user.id));

      // EXPIRED — терминальный статус, nextCheckAt обязан быть NULL.
      await expect(
        repository.transition({
          exchangeId: exchange.id,
          from: 'DRAFT',
          to: 'EXPIRED',
          reason: 'draft_expired',
          at,
          nextCheckAt: later,
        }),
      ).rejects.toThrow(/exchanges_next_check_at_check/);

      expect((await repository.findById(exchange.id))?.status).toBe('DRAFT');
      expect(await history(exchange.id)).toHaveLength(1);
    });
  });

  describe('recordCheckFailure / recordCheckSuccess', () => {
    async function waitingDeposit(userId: string) {
      const { exchange } = await repository.createDraft(newDraft(userId));
      await repository.transition({
        exchangeId: exchange.id,
        from: 'DRAFT',
        to: 'QUOTED',
        reason: 'quote_obtained',
        at,
        nextCheckAt: later,
        patch: { expectedToAmount: '0.001', quoteExpiresAt: later },
      });
      await repository.transition({
        exchangeId: exchange.id,
        from: 'QUOTED',
        to: 'AWAITING_CONFIRMATION',
        reason: 'confirmation_requested',
        at,
        nextCheckAt: later,
      });
      await repository.transition({
        exchangeId: exchange.id,
        from: 'AWAITING_CONFIRMATION',
        to: 'CREATING',
        reason: 'user_confirmed',
        at,
        nextCheckAt: later,
      });
      return repository.transition({
        exchangeId: exchange.id,
        from: 'CREATING',
        to: 'WAITING_DEPOSIT',
        reason: 'provider_exchange_created',
        at,
        nextCheckAt: later,
        patch: {
          providerExchangeId: randomUUID(),
          payinAddress: 'test-payin-address',
          providerStatus: 'waiting',
        },
      });
    }

    it('считает неудачи и сбрасывает счётчик при успехе, истории не пишут', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const historyBefore = (await history(exchange.id)).length;

      await repository.recordCheckFailure({
        exchangeId: exchange.id,
        expectedStatus: 'WAITING_DEPOSIT',
        at,
        nextCheckAt: later,
      });
      const failed = await repository.recordCheckFailure({
        exchangeId: exchange.id,
        expectedStatus: 'WAITING_DEPOSIT',
        at,
        nextCheckAt: later,
      });
      expect(failed.checkFailureCount).toBe(2);
      expect(failed.lastCheckedAt).toEqual(at);

      const ok = await repository.recordCheckSuccess({
        exchangeId: exchange.id,
        expectedStatus: 'WAITING_DEPOSIT',
        at,
        nextCheckAt: later,
        providerStatus: 'waiting',
      });
      expect(ok.checkFailureCount).toBe(0);
      expect(await history(exchange.id)).toHaveLength(historyBefore);
    });

    it('учитывает ожидаемый статус (compare-and-set)', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);

      await expect(
        repository.recordCheckFailure({
          exchangeId: exchange.id,
          expectedStatus: 'CONFIRMING',
          at,
          nextCheckAt: later,
        }),
      ).rejects.toThrow(ExchangeStatusConflictError);
    });
  });
});
