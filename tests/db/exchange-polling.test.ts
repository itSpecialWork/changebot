/**
 * Интеграционные тесты фонового опроса: захват созревших обменов (lease)
 * и ExchangeService.pollDueExchanges. Нужна TEST_DATABASE_URL.
 *
 * Тестовые часы стоят в прошлом (2020), поэтому обмены из других тестовых файлов
 * (они живут в 2026) не считаются созревшими и опросом не затрагиваются.
 * Строки прошлых запусков остаются в БД, поэтому проверки не опираются на точное
 * число захваченных обменов.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ExchangeService } from '../../src/application/exchanges/exchange-service.js';
import type { ExchangeRecord } from '../../src/domain/exchanges/exchange.js';
import { ExchangeProviderError } from '../../src/domain/exchanges/exchange-provider.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import { PrismaExchangeRepository } from '../../src/database/repositories/prisma-exchange-repository.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';
import { createLogger } from '../../src/observability/logger.js';
import { createTestUser, setupTestDatabase, testDatabaseUrl } from './test-database.js';

const START = new Date('2020-01-01T00:00:00.000Z');
const SECOND = 1000;
const WAITING = ['WAITING_DEPOSIT', 'CONFIRMING', 'EXCHANGING', 'SENDING', 'VERIFYING'] as const;

describe.skipIf(!testDatabaseUrl)('опрос обменов', () => {
  let prisma: PrismaClient;
  let repository: PrismaExchangeRepository;
  let now: Date;
  let provider: MockExchangeProvider;
  let service: ExchangeService;

  beforeAll(() => {
    prisma = setupTestDatabase();
    repository = new PrismaExchangeRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    now = START;
    provider = new MockExchangeProvider({ now: () => now });
    service = new ExchangeService({
      repository,
      provider,
      providerKind: 'MOCK',
      logger: createLogger({ nodeEnv: 'test', logLevel: 'silent' }),
      now: () => now,
    });
  });

  /** Создаёт обмен в WAITING_DEPOSIT; nextCheckAt = START + 30 с. */
  async function waitingDeposit(): Promise<ExchangeRecord> {
    const user = await createTestUser(prisma);
    const draft = await service.createDraft({
      userId: user.id,
      clientRequestId: randomUUID(),
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      fromAmount: '100',
      rateType: 'FLOATING',
      payoutAddress: 'test-payout-address',
    });
    await service.requestQuote(user.id, draft.id);
    await service.requestConfirmation(user.id, draft.id);
    return service.confirmAndCreate(user.id, draft.id);
  }

  const claim = (at: Date, leaseMs = 20 * SECOND) =>
    repository.claimDueForProviderCheck({
      now: at,
      limit: 1000,
      statuses: WAITING,
      provider: 'MOCK',
      leaseUntil: new Date(at.getTime() + leaseMs),
    });

  const at = (ms: number) => new Date(START.getTime() + ms);

  describe('claimDueForProviderCheck', () => {
    it('берёт обмен только когда подошёл срок и закрепляет его lease', async () => {
      const exchange = await waitingDeposit();

      expect(await claim(at(29 * SECOND))).not.toContain(exchange.id);

      expect(await claim(at(30 * SECOND))).toContain(exchange.id);
      const leased = await repository.findById(exchange.id);
      expect(leased?.nextCheckAt).toEqual(at(50 * SECOND));

      // Пока lease действует, другой worker обмен не получит.
      expect(await claim(at(49 * SECOND))).not.toContain(exchange.id);
      // После истечения lease обмен возвращается в работу.
      expect(await claim(at(50 * SECOND))).toContain(exchange.id);
    });

    it('не берёт обмены вне запрошенных статусов', async () => {
      const exchange = await waitingDeposit();

      const claimed = await repository.claimDueForProviderCheck({
        now: at(60 * SECOND),
        limit: 1000,
        statuses: ['CONFIRMING'],
        provider: 'MOCK',
        leaseUntil: at(80 * SECOND),
      });
      expect(claimed).not.toContain(exchange.id);
    });

    it('при параллельных захватах не отдаёт один обмен дважды', async () => {
      const exchanges = await Promise.all([waitingDeposit(), waitingDeposit(), waitingDeposit()]);
      const ids = exchanges.map((e) => e.id);

      const results = await Promise.all([claim(at(60 * SECOND)), claim(at(60 * SECOND))]);

      const [first, second] = results;
      expect(first.filter((id) => second.includes(id))).toEqual([]);
      const union = new Set(results.flat());
      for (const id of ids) {
        expect(union.has(id)).toBe(true);
      }
    });

    it('соблюдает limit', async () => {
      await Promise.all([waitingDeposit(), waitingDeposit()]);
      const claimed = await repository.claimDueForProviderCheck({
        now: at(60 * SECOND),
        limit: 1,
        statuses: WAITING,
        provider: 'MOCK',
        leaseUntil: at(80 * SECOND),
      });
      expect(claimed).toHaveLength(1);
    });

    it('не берёт обмен другого провайдера', async () => {
      const exchange = await waitingDeposit();

      const claimed = await repository.claimDueForProviderCheck({
        now: at(60 * SECOND),
        limit: 1000,
        statuses: WAITING,
        provider: 'CHANGENOW',
        leaseUntil: at(80 * SECOND),
      });
      expect(claimed).not.toContain(exchange.id);
      expect((await repository.findById(exchange.id))?.status).toBe('WAITING_DEPOSIT');

      expect(await claim(at(60 * SECOND))).toContain(exchange.id);
    });
  });

  describe('pollDueExchanges', () => {
    it('применяет новый статус провайдера и пишет историю', async () => {
      const exchange = await waitingDeposit();
      provider.advanceStatus(exchange.providerExchangeId ?? '');
      now = at(30 * SECOND);

      const summary = await service.pollDueExchanges(1000);
      expect(summary.transitioned).toBeGreaterThanOrEqual(1);

      const updated = await repository.findById(exchange.id);
      expect(updated).toMatchObject({ status: 'CONFIRMING', providerStatus: 'confirming' });
      const history = await prisma.exchangeStatusHistory.findMany({
        where: { exchangeId: exchange.id },
        orderBy: { sequence: 'desc' },
        take: 1,
      });
      expect(history[0]).toMatchObject({
        fromStatus: 'WAITING_DEPOSIT',
        toStatus: 'CONFIRMING',
        reason: 'provider_status_changed',
      });
    });

    it('не опрашивает обмен повторно до следующего срока проверки', async () => {
      const exchange = await waitingDeposit();
      now = at(30 * SECOND);
      const spy = vi.spyOn(provider, 'getExchangeStatus');

      await service.pollDueExchanges(1000);
      const callsAfterFirst = spy.mock.calls.filter(([id]) => id === exchange.providerExchangeId);
      expect(callsAfterFirst).toHaveLength(1);

      // Первый проход выставил nextCheckAt = now + pollInterval (30 с).
      now = at(40 * SECOND);
      await service.pollDueExchanges(1000);
      const callsAfterSecond = spy.mock.calls.filter(([id]) => id === exchange.providerExchangeId);
      expect(callsAfterSecond).toHaveLength(1);
    });

    it('при недоступности провайдера откладывает проверку, не меняя статус', async () => {
      const exchange = await waitingDeposit();
      const original = provider.getExchangeStatus.bind(provider);
      vi.spyOn(provider, 'getExchangeStatus').mockImplementation((id, options) =>
        id === exchange.providerExchangeId
          ? Promise.reject(new ExchangeProviderError('UNAVAILABLE', 'down'))
          : original(id, options),
      );
      now = at(30 * SECOND);

      const summary = await service.pollDueExchanges(1000);
      expect(summary.deferred).toBeGreaterThanOrEqual(1);

      const updated = await repository.findById(exchange.id);
      expect(updated).toMatchObject({ status: 'WAITING_DEPOSIT', checkFailureCount: 1 });
      expect(updated?.nextCheckAt).toEqual(at(60 * SECOND));
    });

    it('ошибка одного обмена не мешает остальным', async () => {
      const broken = await waitingDeposit();
      const healthy = await waitingDeposit();
      provider.advanceStatus(healthy.providerExchangeId ?? '');
      const original = provider.getExchangeStatus.bind(provider);
      vi.spyOn(provider, 'getExchangeStatus').mockImplementation((id, options) =>
        id === broken.providerExchangeId
          ? Promise.reject(new Error('unexpected'))
          : original(id, options),
      );
      now = at(30 * SECOND);

      const summary = await service.pollDueExchanges(1000);
      expect(summary.errors).toBeGreaterThanOrEqual(1);
      expect((await repository.findById(healthy.id))?.status).toBe('CONFIRMING');
      expect((await repository.findById(broken.id))?.status).toBe('WAITING_DEPOSIT');
    });
  });
});
