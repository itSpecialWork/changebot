/**
 * Интеграционные тесты ExchangeService: реальная БД + MockExchangeProvider
 * (нужна TEST_DATABASE_URL). Реальных обменов и сети здесь нет.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ExchangeNotFoundError,
  ExchangeNotSyncableError,
  ExchangeStatusConflictError,
  IdempotencyKeyReuseError,
  InvalidExchangeInputError,
  QuoteExpiredError,
} from '../../src/application/exchanges/errors.js';
import {
  ExchangeService,
  type CreateDraftInput,
} from '../../src/application/exchanges/exchange-service.js';
import type { ExchangeRecord } from '../../src/domain/exchanges/exchange.js';
import {
  ExchangeProviderError,
  type ProviderExchangeStatus,
} from '../../src/domain/exchanges/exchange-provider.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import { PrismaExchangeRepository } from '../../src/database/repositories/prisma-exchange-repository.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';
import { createLogger } from '../../src/observability/logger.js';
import { createTestUser, setupTestDatabase, testDatabaseUrl } from './test-database.js';

const START = new Date('2026-01-01T00:00:00.000Z');
const MINUTE = 60_000;

describe.skipIf(!testDatabaseUrl)('ExchangeService', () => {
  let prisma: PrismaClient;
  let now: Date;
  let provider: MockExchangeProvider;
  let service: ExchangeService;

  beforeAll(() => {
    prisma = setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  beforeEach(() => {
    now = START;
    provider = new MockExchangeProvider({ now: () => now });
    service = new ExchangeService({
      repository: new PrismaExchangeRepository(prisma),
      provider,
      providerKind: 'MOCK',
      logger: createLogger({ nodeEnv: 'test', logLevel: 'silent' }),
      now: () => now,
    });
  });

  const draftInput = (
    userId: string,
    overrides: Partial<CreateDraftInput> = {},
  ): CreateDraftInput => ({
    userId,
    clientRequestId: randomUUID(),
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    fromAmount: '100',
    rateType: 'FLOATING',
    payoutAddress: 'test-payout-address',
    ...overrides,
  });

  const history = (exchangeId: string) =>
    prisma.exchangeStatusHistory.findMany({ where: { exchangeId }, orderBy: { sequence: 'asc' } });

  /** Доводит обмен до AWAITING_CONFIRMATION. */
  async function awaitingConfirmation(
    userId: string,
    overrides: Partial<CreateDraftInput> = {},
  ): Promise<ExchangeRecord> {
    const draft = await service.createDraft(draftInput(userId, overrides));
    await service.requestQuote(userId, draft.id);
    return service.requestConfirmation(userId, draft.id);
  }

  /** Доводит обмен до WAITING_DEPOSIT. */
  async function waitingDeposit(userId: string): Promise<ExchangeRecord> {
    const exchange = await awaitingConfirmation(userId);
    return service.confirmAndCreate(userId, exchange.id);
  }

  function mockRemoteStatus(overrides: Partial<ProviderExchangeStatus>): void {
    vi.spyOn(provider, 'getExchangeStatus').mockImplementationOnce((providerExchangeId) =>
      Promise.resolve({
        providerExchangeId,
        providerStatus: 'waiting',
        status: 'WAITING_DEPOSIT',
        actualFromAmount: null,
        actualToAmount: null,
        payinHash: null,
        payoutHash: null,
        refundHash: null,
        ...overrides,
      }),
    );
  }

  describe('основной сценарий', () => {
    it('проводит обмен от черновика до WAITING_DEPOSIT с полной историей', async () => {
      const user = await createTestUser(prisma);

      const draft = await service.createDraft(draftInput(user.id, { fromAmount: '100.50' }));
      expect(draft).toMatchObject({
        status: 'DRAFT',
        provider: 'MOCK',
        expectedFromAmount: '100.5',
        nextCheckAt: new Date(START.getTime() + 30 * MINUTE),
      });

      const quoted = await service.requestQuote(user.id, draft.id);
      expect(quoted).toMatchObject({
        status: 'QUOTED',
        expectedToAmount: '0.001608',
        providerRateId: null,
        // floating: срок задаёт сервис (по умолчанию 5 минут)
        quoteExpiresAt: new Date(START.getTime() + 5 * MINUTE),
        nextCheckAt: new Date(START.getTime() + 5 * MINUTE),
      });

      const awaiting = await service.requestConfirmation(user.id, draft.id);
      expect(awaiting.status).toBe('AWAITING_CONFIRMATION');

      const waiting = await service.confirmAndCreate(user.id, draft.id);
      expect(waiting).toMatchObject({
        status: 'WAITING_DEPOSIT',
        providerStatus: 'waiting',
        providerExchangeId: expect.stringMatching(/^mock-exchange-/) as string,
        checkFailureCount: 0,
        nextCheckAt: new Date(START.getTime() + 30_000),
      });
      expect(waiting.payinAddress).toMatch(/^mock-payin-address-/);

      const rows = await history(draft.id);
      expect(rows.map((r) => [r.sequence, r.fromStatus, r.toStatus, r.reason])).toEqual([
        [1, null, 'DRAFT', 'draft_created'],
        [2, 'DRAFT', 'QUOTED', 'quote_obtained'],
        [3, 'QUOTED', 'AWAITING_CONFIRMATION', 'confirmation_requested'],
        [4, 'AWAITING_CONFIRMATION', 'CREATING', 'user_confirmed'],
        [5, 'CREATING', 'WAITING_DEPOSIT', 'provider_exchange_created'],
      ]);
    });

    it('сохраняет fixed-курс провайдера', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(user.id, { rateType: 'FIXED' }));
      const quoted = await service.requestQuote(user.id, draft.id);

      expect(quoted.providerRateId).toMatch(/^mock-rate-/);
      expect(quoted.quoteExpiresAt).toEqual(new Date(START.getTime() + MINUTE));

      await service.requestConfirmation(user.id, draft.id);
      const waiting = await service.confirmAndCreate(user.id, draft.id);
      expect(waiting.expectedToAmount).toBe(quoted.expectedToAmount);
    });
  });

  describe('createDraft', () => {
    it('идемпотентен: тот же clientRequestId возвращает тот же обмен', async () => {
      const user = await createTestUser(prisma);
      const input = draftInput(user.id);
      const first = await service.createDraft(input);
      const second = await service.createDraft(input);

      expect(second.id).toBe(first.id);
      expect(await history(first.id)).toHaveLength(1);
    });

    it('отклоняет тот же ключ с другими параметрами', async () => {
      const user = await createTestUser(prisma);
      const input = draftInput(user.id);
      await service.createDraft(input);

      await expect(service.createDraft({ ...input, fromAmount: '200' })).rejects.toThrow(
        IdempotencyKeyReuseError,
      );
    });

    it('ключ зависит от пользователя: одинаковый clientRequestId у разных пользователей не конфликтует', async () => {
      const first = await createTestUser(prisma);
      const second = await createTestUser(prisma);
      const clientRequestId = randomUUID();

      const a = await service.createDraft(draftInput(first.id, { clientRequestId }));
      const b = await service.createDraft(draftInput(second.id, { clientRequestId }));
      expect(a.id).not.toBe(b.id);
    });

    it.each([
      ['сумма не число', { fromAmount: '1e3' }],
      ['сумма равна нулю', { fromAmount: '0' }],
      ['отрицательная сумма', { fromAmount: '-1' }],
      ['пустой адрес получения', { payoutAddress: '  ' }],
      ['пустой extraId', { payoutExtraId: '' }],
      ['пустой clientRequestId', { clientRequestId: '' }],
    ])('отклоняет некорректный ввод: %s', async (_name, overrides) => {
      const user = await createTestUser(prisma);
      await expect(service.createDraft(draftInput(user.id, overrides))).rejects.toThrow(
        InvalidExchangeInputError,
      );
    });
  });

  describe('владелец обмена', () => {
    it('чужой обмен неотличим от несуществующего', async () => {
      const owner = await createTestUser(prisma);
      const stranger = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(owner.id));

      await expect(service.requestQuote(stranger.id, draft.id)).rejects.toThrow(
        ExchangeNotFoundError,
      );
      await expect(service.requestQuote(owner.id, randomUUID())).rejects.toThrow(
        ExchangeNotFoundError,
      );
    });
  });

  describe('порядок и защита от повторов', () => {
    it('не позволяет пропускать этапы', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(user.id));

      await expect(service.requestConfirmation(user.id, draft.id)).rejects.toThrow(
        ExchangeStatusConflictError,
      );
      await expect(service.confirmAndCreate(user.id, draft.id)).rejects.toThrow(
        ExchangeStatusConflictError,
      );
    });

    it('повторное подтверждение не создаёт второй обмен у провайдера', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);
      const createSpy = vi.spyOn(provider, 'createExchange');

      await service.confirmAndCreate(user.id, exchange.id);
      await expect(service.confirmAndCreate(user.id, exchange.id)).rejects.toThrow(
        ExchangeStatusConflictError,
      );
      expect(createSpy).toHaveBeenCalledTimes(1);
    });

    it('при гонке двойного нажатия до провайдера доходит только один запрос', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);
      const createSpy = vi.spyOn(provider, 'createExchange');

      const results = await Promise.allSettled([
        service.confirmAndCreate(user.id, exchange.id),
        service.confirmAndCreate(user.id, exchange.id),
        service.confirmAndCreate(user.id, exchange.id),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const result of results) {
        if (result.status === 'rejected') {
          expect(result.reason).toBeInstanceOf(ExchangeStatusConflictError);
        }
      }
      expect(createSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('истечение котировки', () => {
    it('подтверждение после срока переводит обмен в EXPIRED', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);
      const createSpy = vi.spyOn(provider, 'createExchange');

      now = new Date(START.getTime() + 5 * MINUTE);
      await expect(service.confirmAndCreate(user.id, exchange.id)).rejects.toThrow(
        QuoteExpiredError,
      );

      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(stored.status).toBe('EXPIRED');
      expect(stored.nextCheckAt).toBeNull();
      expect(createSpy).not.toHaveBeenCalled();
      expect((await history(exchange.id)).at(-1)?.reason).toBe('quote_expired');
    });

    it('показ котировки после срока тоже переводит обмен в EXPIRED', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(user.id));
      await service.requestQuote(user.id, draft.id);

      now = new Date(START.getTime() + 6 * MINUTE);
      await expect(service.requestConfirmation(user.id, draft.id)).rejects.toThrow(
        QuoteExpiredError,
      );
    });

    it('worker сам закрывает неподтверждённую котировку', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);

      now = new Date(START.getTime() + 5 * MINUTE);
      for (let pass = 0; pass < 20; pass += 1) {
        const current = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
        if (current.status === 'EXPIRED') break;
        await service.pollDueExchanges(100);
      }

      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(stored.status).toBe('EXPIRED');
      expect(stored.nextCheckAt).toBeNull();
      expect((await history(exchange.id)).at(-1)?.reason).toBe('quote_expired');
      const notes = await prisma.notificationOutbox.findMany({
        where: { exchangeId: exchange.id },
      });
      expect(notes).toHaveLength(1);
      expect(JSON.stringify(notes[0]?.payload)).not.toContain('test-payout-address');
    });

    it('поздняя отмена пишет quote_expired и не ставит уведомление', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);

      now = new Date(START.getTime() + 5 * MINUTE);
      await service.cancelByUser(user.id, exchange.id);

      expect((await history(exchange.id)).at(-1)?.reason).toBe('quote_expired');
      expect(await prisma.notificationOutbox.count({ where: { exchangeId: exchange.id } })).toBe(0);
    });

    it('черновик без котировки закрывается по своему сроку без уведомления', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(user.id));

      now = new Date(START.getTime() + 30 * MINUTE);
      for (let pass = 0; pass < 20; pass += 1) {
        const current = await prisma.exchange.findUniqueOrThrow({ where: { id: draft.id } });
        if (current.status === 'EXPIRED') break;
        await service.pollDueExchanges(100);
      }

      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: draft.id } });
      expect(stored.status).toBe('EXPIRED');
      expect((await history(draft.id)).at(-1)?.reason).toBe('draft_expired');
      expect(await prisma.notificationOutbox.count({ where: { exchangeId: draft.id } })).toBe(0);
    });
  });

  describe('исходы createExchange у провайдера', () => {
    it('окончательный отказ переводит обмен в FAILED и пробрасывает ошибку', async () => {
      const user = await createTestUser(prisma);
      // XRP требует extraId, а в черновике его нет: мок отклонит создание.
      const exchange = await awaitingConfirmation(user.id, {
        toCurrency: 'xrp',
        toNetwork: 'xrp',
      });

      await expect(service.confirmAndCreate(user.id, exchange.id)).rejects.toMatchObject({
        code: 'INVALID_REQUEST',
      });

      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(stored.status).toBe('FAILED');
      expect(stored.nextCheckAt).toBeNull();
      expect(stored.providerExchangeId).toBeNull();
      expect((await history(exchange.id)).at(-1)?.reason).toBe('create_failed_invalid_request');
    });

    it('временная ошибка оставляет обмен в CREATING для восстановления', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);
      vi.spyOn(provider, 'createExchange').mockRejectedValueOnce(
        new ExchangeProviderError('UNAVAILABLE', 'timeout'),
      );

      await expect(service.confirmAndCreate(user.id, exchange.id)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });

      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(stored.status).toBe('CREATING');
      expect(stored.providerExchangeId).toBeNull();
      expect(stored.nextCheckAt).toEqual(new Date(START.getTime() + 2 * MINUTE));
    });

    it('ошибка, не относящаяся к провайдеру, тоже не закрывает обмен', async () => {
      const user = await createTestUser(prisma);
      const exchange = await awaitingConfirmation(user.id);
      vi.spyOn(provider, 'createExchange').mockRejectedValueOnce(new Error('boom'));

      await expect(service.confirmAndCreate(user.id, exchange.id)).rejects.toThrow('boom');
      const stored = await prisma.exchange.findUniqueOrThrow({ where: { id: exchange.id } });
      expect(stored.status).toBe('CREATING');
    });
  });

  describe('syncWithProvider', () => {
    it('проходит цепочку статусов до FINISHED и сохраняет фактические суммы', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const providerExchangeId = exchange.providerExchangeId ?? '';

      const unchanged = await service.syncWithProvider(exchange.id);
      expect(unchanged.outcome).toBe('unchanged');

      provider.advanceStatus(providerExchangeId);
      expect((await service.syncWithProvider(exchange.id)).exchange.status).toBe('CONFIRMING');
      provider.advanceStatus(providerExchangeId);
      expect((await service.syncWithProvider(exchange.id)).exchange.status).toBe('EXCHANGING');
      provider.advanceStatus(providerExchangeId);
      expect((await service.syncWithProvider(exchange.id)).exchange.status).toBe('SENDING');
      provider.advanceStatus(providerExchangeId);

      const finished = await service.syncWithProvider(exchange.id);
      expect(finished.outcome).toBe('transitioned');
      expect(finished.exchange).toMatchObject({
        status: 'FINISHED',
        providerStatus: 'finished',
        payinHash: null,
        payoutHash: null,
        refundHash: null,
        actualFromAmount: '100',
        actualToAmount: '0.0016',
        nextCheckAt: null,
      });

      const rows = await history(exchange.id);
      expect(rows.slice(5).map((r) => [r.fromStatus, r.toStatus, r.reason])).toEqual([
        ['WAITING_DEPOSIT', 'CONFIRMING', 'provider_status_changed'],
        ['CONFIRMING', 'EXCHANGING', 'provider_status_changed'],
        ['EXCHANGING', 'SENDING', 'provider_status_changed'],
        ['SENDING', 'FINISHED', 'provider_status_changed'],
      ]);
    });

    it('сохраняет присланный хэш и без смены статуса, в уведомление его не кладёт', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const payinHash = '00payinhash';
      const payoutHash = 'payout-hash';

      mockRemoteStatus({ providerStatus: 'confirming', status: 'CONFIRMING', payinHash });
      const moved = await service.syncWithProvider(exchange.id);
      expect(moved.exchange).toMatchObject({ status: 'CONFIRMING', payinHash, payoutHash: null });

      const note = await prisma.notificationOutbox.findFirstOrThrow({
        where: { exchangeId: exchange.id },
      });
      expect(JSON.stringify(note.payload)).not.toContain(payinHash);

      mockRemoteStatus({ providerStatus: 'confirming', status: 'CONFIRMING', payoutHash });
      const same = await service.syncWithProvider(exchange.id);
      expect(same.outcome).toBe('unchanged');
      expect(same.exchange).toMatchObject({ payinHash, payoutHash, refundHash: null });
      expect(await prisma.notificationOutbox.count({ where: { exchangeId: exchange.id } })).toBe(1);
    });

    it('допускает пропуск промежуточных статусов', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      provider.setProviderStatus(exchange.providerExchangeId ?? '', 'finished');

      const result = await service.syncWithProvider(exchange.id);
      expect(result.exchange.status).toBe('FINISHED');
    });

    it.each([
      ['failed', 'FAILED'],
      ['refunded', 'REFUNDED'],
    ])('терминальный статус %s закрывает проверки (nextCheckAt = NULL)', async (raw, internal) => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      provider.setProviderStatus(exchange.providerExchangeId ?? '', raw);

      const result = await service.syncWithProvider(exchange.id);
      expect(result.exchange).toMatchObject({ status: internal, nextCheckAt: null });
    });

    it('неизвестный сырой статус отправляет обмен в VERIFYING', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      provider.setProviderStatus(exchange.providerExchangeId ?? '', 'something-new');

      const result = await service.syncWithProvider(exchange.id);
      expect(result.exchange).toMatchObject({
        status: 'VERIFYING',
        providerStatus: 'something-new',
      });
      expect(result.exchange.nextCheckAt).not.toBeNull();
    });

    it('finished без фактических сумм не фиксируется: статус прежний, неудача считается', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      const historyBefore = (await history(exchange.id)).length;
      mockRemoteStatus({ providerStatus: 'finished', status: 'FINISHED' });

      const result = await service.syncWithProvider(exchange.id);

      expect(result).toMatchObject({ outcome: 'deferred', reason: 'finished_without_amounts' });
      expect(result.exchange).toMatchObject({
        status: 'WAITING_DEPOSIT',
        providerStatus: 'waiting',
        checkFailureCount: 1,
        lastCheckedAt: START,
        nextCheckAt: new Date(START.getTime() + 30_000),
        actualFromAmount: null,
        actualToAmount: null,
      });
      expect(await history(exchange.id)).toHaveLength(historyBefore);
    });

    it('повторные неудачи увеличивают задержку, успех сбрасывает счётчик', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);

      mockRemoteStatus({ providerStatus: 'finished', status: 'FINISHED' });
      await service.syncWithProvider(exchange.id);
      mockRemoteStatus({ providerStatus: 'finished', status: 'FINISHED' });
      const second = await service.syncWithProvider(exchange.id);
      expect(second.exchange.checkFailureCount).toBe(2);
      expect(second.exchange.nextCheckAt).toEqual(new Date(START.getTime() + 60_000));

      const recovered = await service.syncWithProvider(exchange.id);
      expect(recovered.outcome).toBe('unchanged');
      expect(recovered.exchange.checkFailureCount).toBe(0);
    });

    it('невозможный переход от провайдера откладывается, статус не меняется', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      provider.setProviderStatus(exchange.providerExchangeId ?? '', 'sending');
      await service.syncWithProvider(exchange.id);

      // Провайдер «откатился» назад: SENDING → CONFIRMING запрещён.
      mockRemoteStatus({ providerStatus: 'confirming', status: 'CONFIRMING' });
      const result = await service.syncWithProvider(exchange.id);

      expect(result).toMatchObject({ outcome: 'deferred', reason: 'invalid_transition' });
      expect(result.exchange.status).toBe('SENDING');
      expect(result.exchange.checkFailureCount).toBe(1);
    });

    it('окончательный отказ провайдера снимает обмен с опроса', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      vi.spyOn(provider, 'getExchangeStatus').mockRejectedValueOnce(
        new ExchangeProviderError('INVALID_REQUEST', 'bad id'),
      );

      const result = await service.syncWithProvider(exchange.id);

      expect(result.outcome).toBe('transitioned');
      expect(result.exchange).toMatchObject({ status: 'FAILED', nextCheckAt: null });
      expect((await history(exchange.id)).at(-1)).toMatchObject({
        fromStatus: 'WAITING_DEPOSIT',
        toStatus: 'FAILED',
        reason: 'provider_invalid_request',
      });
      await expect(service.syncWithProvider(exchange.id)).rejects.toThrow(ExchangeNotSyncableError);
    });

    it('ошибка провайдера откладывает проверку и не бросает исключение', async () => {
      const user = await createTestUser(prisma);
      const exchange = await waitingDeposit(user.id);
      vi.spyOn(provider, 'getExchangeStatus').mockRejectedValueOnce(
        new ExchangeProviderError('UNAVAILABLE', 'down'),
      );

      const result = await service.syncWithProvider(exchange.id);
      expect(result).toMatchObject({ outcome: 'deferred', reason: 'provider_unavailable' });
      expect(result.exchange.status).toBe('WAITING_DEPOSIT');
      expect(result.exchange.checkFailureCount).toBe(1);
    });

    it('не синхронизирует обмены без провайдерской части и завершённые', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft(draftInput(user.id));
      await expect(service.syncWithProvider(draft.id)).rejects.toThrow(ExchangeNotSyncableError);

      const exchange = await waitingDeposit(user.id);
      provider.setProviderStatus(exchange.providerExchangeId ?? '', 'failed');
      await service.syncWithProvider(exchange.id);
      await expect(service.syncWithProvider(exchange.id)).rejects.toThrow(ExchangeNotSyncableError);

      await expect(service.syncWithProvider(randomUUID())).rejects.toThrow(ExchangeNotFoundError);
    });
  });

  describe('same asset', () => {
    it('сохраняет введённую сумму отправки и создаёт обычный обмен', async () => {
      const user = await createTestUser(prisma);
      const draft = await service.createDraft({
        userId: user.id,
        clientRequestId: randomUUID(),
        fromCurrency: 'usdt',
        fromNetwork: 'trx',
        toCurrency: 'usdt',
        toNetwork: 'trx',
        fromAmount: '1000',
        rateType: 'FIXED',
        payoutAddress: 'test-payout-address',
      });
      expect(draft.expectedFromAmount).toBe('1000');
      expect(draft.expectedToAmount).toBeNull();

      await service.requestQuote(user.id, draft.id);
      await service.requestConfirmation(user.id, draft.id);
      const waiting = await service.confirmAndCreate(user.id, draft.id);

      expect(waiting).toMatchObject({
        status: 'WAITING_DEPOSIT',
        providerStatus: 'waiting',
        fromCurrency: 'usdt',
        fromNetwork: 'trx',
        toCurrency: 'usdt',
        toNetwork: 'trx',
        expectedFromAmount: '1000',
        expectedToAmount: '979',
        rateType: 'FIXED',
      });
      expect(waiting.providerExchangeId).toMatch(/^mock-exchange-/);
      expect(waiting.payinAddress).toMatch(/^mock-payin-address-/);
    });
  });
});
