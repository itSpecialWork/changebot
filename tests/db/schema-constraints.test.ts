/**
 * Интеграционные тесты ограничений схемы (unique, CHECK, FK, триггер истории).
 *
 * Запускаются только при заданной TEST_DATABASE_URL (отдельная БД, имя
 * которой оканчивается на `_test`). Без неё тесты пропускаются, чтобы
 * `npm test` не требовал PostgreSQL.
 *
 * Тесты не очищают данные (история неизменяема), а используют уникальные
 * значения для каждого случая. Миграции применяются через `prisma migrate deploy`.
 */
import { execFileSync } from 'node:child_process';
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPrismaClient, type PrismaClient } from '../../src/database/prisma.js';
import type { Prisma } from '../../src/database/generated/client.js';

const testDatabaseUrl = process.env.TEST_DATABASE_URL;

function assertTestDatabase(url: string): void {
  const dbName = new URL(url).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a database whose name ends with "_test"');
  }
}

/** Ожидает отказ БД именно из-за указанного ограничения (имя есть в тексте ошибки). */
async function expectCheckViolation(promise: Promise<unknown>, constraint: string): Promise<void> {
  await expect(promise).rejects.toThrow(new RegExp(`violates check constraint .*${constraint}`));
}

async function expectUniqueViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(/Unique constraint failed/);
}

async function expectForeignKeyViolation(promise: Promise<unknown>): Promise<void> {
  await expect(promise).rejects.toThrow(/Foreign key constraint/);
}

type ExchangeData = Prisma.ExchangeUncheckedCreateInput;

const inOneHour = (): Date => new Date(Date.now() + 3_600_000);

function draftData(userId: string, overrides: Partial<ExchangeData> = {}): ExchangeData {
  return {
    userId,
    provider: 'MOCK',
    idempotencyKey: randomUUID(),
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    expectedFromAmount: '100.5',
    rateType: 'FLOATING',
    status: 'DRAFT',
    nextCheckAt: inOneHour(),
    ...overrides,
  };
}

function waitingDepositData(userId: string, overrides: Partial<ExchangeData> = {}): ExchangeData {
  return draftData(userId, {
    status: 'WAITING_DEPOSIT',
    expectedToAmount: '0.001',
    quoteExpiresAt: inOneHour(),
    payoutAddress: 'test-payout-address',
    providerExchangeId: randomUUID(),
    payinAddress: 'test-payin-address',
    providerStatus: 'waiting',
    ...overrides,
  });
}

describe.skipIf(!testDatabaseUrl)('схема БД: ограничения', () => {
  let prisma: PrismaClient;

  const createUser = () =>
    prisma.user.create({ data: { telegramId: BigInt(randomInt(1, 2 ** 31)) * 10_000n + 7n } });

  beforeAll(() => {
    if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
    const url = testDatabaseUrl;
    assertTestDatabase(url);
    execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
      env: { ...process.env, DATABASE_URL: url },
      stdio: 'pipe',
    });
    prisma = createPrismaClient(url);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  describe('User', () => {
    it('telegramId уникален и хранит значения больше int32', async () => {
      const telegramId = 7_000_000_000n + BigInt(randomInt(1, 1_000_000_000));
      const user = await prisma.user.create({ data: { telegramId } });
      expect(user.telegramId).toBe(telegramId);
      expect(user.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(user.id).not.toBe(telegramId.toString());

      await expectUniqueViolation(prisma.user.create({ data: { telegramId } }));
    });

    it('telegramId должен быть положительным', async () => {
      await expectCheckViolation(
        prisma.user.create({ data: { telegramId: -5n } }),
        'users_telegram_id_positive_check',
      );
    });
  });

  describe('Exchange: уникальность', () => {
    it('idempotencyKey уникален', async () => {
      const user = await createUser();
      const data = draftData(user.id);
      await prisma.exchange.create({ data });
      await expectUniqueViolation(
        prisma.exchange.create({
          data: draftData(user.id, { idempotencyKey: data.idempotencyKey }),
        }),
      );
    });

    it('providerExchangeId уникален в пределах провайдера', async () => {
      const user = await createUser();
      const providerExchangeId = randomUUID();
      await prisma.exchange.create({ data: waitingDepositData(user.id, { providerExchangeId }) });

      await expectUniqueViolation(
        prisma.exchange.create({ data: waitingDepositData(user.id, { providerExchangeId }) }),
      );

      // Другой провайдер может иметь тот же идентификатор.
      const other = await prisma.exchange.create({
        data: waitingDepositData(user.id, { providerExchangeId, provider: 'CHANGENOW' }),
      });
      expect(other.provider).toBe('CHANGENOW');
    });

    it('несколько черновиков без providerExchangeId допустимы', async () => {
      const user = await createUser();
      await prisma.exchange.create({ data: draftData(user.id) });
      await prisma.exchange.create({ data: draftData(user.id) });
    });
  });

  describe('Exchange: суммы, строки', () => {
    it('Decimal хранит 24 знака после запятой без потерь', async () => {
      const user = await createUser();
      const amount = '123456789.123456789012345678901234';
      const created = await prisma.exchange.create({
        data: draftData(user.id, { expectedFromAmount: amount }),
      });
      expect(created.expectedFromAmount.toFixed()).toBe(amount);
    });

    it('сумма должна быть положительной', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: draftData(user.id, { expectedFromAmount: '0' }) }),
        'exchanges_amounts_check',
      );
      await expectCheckViolation(
        prisma.exchange.create({ data: draftData(user.id, { expectedFromAmount: '-1' }) }),
        'exchanges_amounts_check',
      );
    });

    it('memo/extraId сохраняется строкой с ведущими нулями', async () => {
      const user = await createUser();
      const created = await prisma.exchange.create({
        data: waitingDepositData(user.id, { payinExtraId: '0012345678' }),
      });
      expect(created.payinExtraId).toBe('0012345678');
    });

    it('пустой хэш запрещён, ведущие нули в хэше сохраняются', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: waitingDepositData(user.id, { payinHash: '' }) }),
        'exchanges_optional_text_check',
      );
      const created = await prisma.exchange.create({
        data: waitingDepositData(user.id, { payoutHash: '00abc' }),
      });
      expect(created.payoutHash).toBe('00abc');
      expect(created.payinHash).toBeNull();
    });

    it('пустые адрес и extraId запрещены', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: waitingDepositData(user.id, { payoutExtraId: '' }) }),
        'exchanges_optional_text_check',
      );
      await expectCheckViolation(
        prisma.exchange.create({ data: waitingDepositData(user.id, { refundAddress: '' }) }),
        'exchanges_optional_text_check',
      );
    });

    it('пустые валюта и сеть запрещены', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: draftData(user.id, { fromNetwork: '' }) }),
        'exchanges_required_text_check',
      );
    });
  });

  describe('Exchange: инвариант nextCheckAt', () => {
    it('нетерминальный статус требует nextCheckAt', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: draftData(user.id, { nextCheckAt: null }) }),
        'exchanges_next_check_at_check',
      );
    });

    it('терминальный статус запрещает nextCheckAt', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({
          data: draftData(user.id, { status: 'EXPIRED', nextCheckAt: inOneHour() }),
        }),
        'exchanges_next_check_at_check',
      );
      await prisma.exchange.create({
        data: draftData(user.id, { status: 'EXPIRED', nextCheckAt: null }),
      });
    });
  });

  describe('Exchange: обязательные поля по стадиям', () => {
    it('DRAFT не может иметь providerExchangeId', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({ data: draftData(user.id, { providerExchangeId: randomUUID() }) }),
        'exchanges_provider_exchange_id_stage_check',
      );
    });

    it('QUOTED требует expectedToAmount и quoteExpiresAt', async () => {
      const user = await createUser();
      const quoted = draftData(user.id, {
        status: 'QUOTED',
        expectedToAmount: '0.001',
        quoteExpiresAt: inOneHour(),
      });
      await prisma.exchange.create({ data: quoted });

      await expectCheckViolation(
        prisma.exchange.create({
          data: { ...quoted, idempotencyKey: randomUUID(), expectedToAmount: null },
        }),
        'exchanges_quote_stage_check',
      );
      await expectCheckViolation(
        prisma.exchange.create({
          data: { ...quoted, idempotencyKey: randomUUID(), quoteExpiresAt: null },
        }),
        'exchanges_quote_stage_check',
      );
    });

    it('FIXED требует providerRateId после QUOTED, FLOATING его запрещает', async () => {
      const user = await createUser();
      const quotedFixed = draftData(user.id, {
        status: 'QUOTED',
        rateType: 'FIXED',
        expectedToAmount: '0.001',
        quoteExpiresAt: inOneHour(),
      });
      await expectCheckViolation(
        prisma.exchange.create({ data: quotedFixed }),
        'exchanges_quote_stage_check',
      );
      await prisma.exchange.create({
        data: { ...quotedFixed, providerRateId: 'rate-1', idempotencyKey: randomUUID() },
      });

      await expectCheckViolation(
        prisma.exchange.create({
          data: draftData(user.id, { rateType: 'FLOATING', providerRateId: 'rate-2' }),
        }),
        'exchanges_provider_rate_id_fixed_check',
      );
    });

    it('AWAITING_CONFIRMATION требует payoutAddress', async () => {
      const user = await createUser();
      const data = draftData(user.id, {
        status: 'AWAITING_CONFIRMATION',
        expectedToAmount: '0.001',
        quoteExpiresAt: inOneHour(),
      });
      await expectCheckViolation(prisma.exchange.create({ data }), 'exchanges_payout_stage_check');
      await prisma.exchange.create({
        data: { ...data, payoutAddress: 'test-payout-address', idempotencyKey: randomUUID() },
      });
    });

    it('WAITING_DEPOSIT требует providerExchangeId, payinAddress и providerStatus', async () => {
      const user = await createUser();
      await prisma.exchange.create({ data: waitingDepositData(user.id) });

      const expected = {
        providerExchangeId: 'exchanges_provider_exchange_id_stage_check',
        payinAddress: 'exchanges_deposit_stage_check',
        providerStatus: 'exchanges_deposit_stage_check',
      } as const;

      for (const [field, constraint] of Object.entries(expected)) {
        await expectCheckViolation(
          prisma.exchange.create({ data: waitingDepositData(user.id, { [field]: null }) }),
          constraint,
        );
      }
    });

    it('EXPIRED не может иметь providerExchangeId', async () => {
      const user = await createUser();
      await expectCheckViolation(
        prisma.exchange.create({
          data: draftData(user.id, {
            status: 'EXPIRED',
            nextCheckAt: null,
            providerExchangeId: randomUUID(),
          }),
        }),
        'exchanges_provider_exchange_id_stage_check',
      );
    });

    it('FINISHED требует фактические суммы', async () => {
      const user = await createUser();
      const finished = waitingDepositData(user.id, { status: 'FINISHED', nextCheckAt: null });
      await expectCheckViolation(
        prisma.exchange.create({ data: finished }),
        'exchanges_finished_stage_check',
      );

      await prisma.exchange.create({
        data: {
          ...finished,
          idempotencyKey: randomUUID(),
          providerExchangeId: randomUUID(),
          actualFromAmount: '100.5',
          actualToAmount: '0.00099',
        },
      });
    });
  });

  describe('Внешние ключи', () => {
    it('нельзя удалить пользователя с обменами', async () => {
      const user = await createUser();
      await prisma.exchange.create({ data: draftData(user.id) });
      await expectForeignKeyViolation(prisma.user.delete({ where: { id: user.id } }));
    });

    it('нельзя удалить обмен с историей', async () => {
      const user = await createUser();
      const exchange = await prisma.exchange.create({ data: draftData(user.id) });
      await prisma.exchangeStatusHistory.create({
        data: { exchangeId: exchange.id, sequence: 1, toStatus: 'DRAFT', reason: 'created' },
      });
      await expectForeignKeyViolation(prisma.exchange.delete({ where: { id: exchange.id } }));
    });
  });

  describe('ExchangeStatusHistory', () => {
    async function createExchangeWithFirstRow() {
      const user = await createUser();
      const exchange = await prisma.exchange.create({ data: draftData(user.id) });
      const first = await prisma.exchangeStatusHistory.create({
        data: { exchangeId: exchange.id, sequence: 1, toStatus: 'DRAFT', reason: 'created' },
      });
      return { exchange, first };
    }

    it('первая запись без fromStatus, последующие с fromStatus', async () => {
      const { exchange } = await createExchangeWithFirstRow();

      const second = await prisma.exchangeStatusHistory.create({
        data: {
          exchangeId: exchange.id,
          sequence: 2,
          fromStatus: 'DRAFT',
          toStatus: 'QUOTED',
          reason: 'quote_obtained',
        },
      });
      expect(second.fromStatus).toBe('DRAFT');

      // Не первая запись без fromStatus.
      await expectCheckViolation(
        prisma.exchangeStatusHistory.create({
          data: { exchangeId: exchange.id, sequence: 3, toStatus: 'QUOTED', reason: 'x' },
        }),
        'exchange_status_history_first_row_check',
      );
      // Первая запись с fromStatus.
      const otherUser = await createUser();
      const other = await prisma.exchange.create({ data: draftData(otherUser.id) });
      await expectCheckViolation(
        prisma.exchangeStatusHistory.create({
          data: {
            exchangeId: other.id,
            sequence: 1,
            fromStatus: 'DRAFT',
            toStatus: 'QUOTED',
            reason: 'x',
          },
        }),
        'exchange_status_history_first_row_check',
      );
    });

    it('sequence уникален в пределах обмена', async () => {
      const { exchange } = await createExchangeWithFirstRow();
      await expectUniqueViolation(
        prisma.exchangeStatusHistory.create({
          data: { exchangeId: exchange.id, sequence: 1, toStatus: 'DRAFT', reason: 'dup' },
        }),
      );
    });

    it('переход в тот же статус запрещён', async () => {
      const { exchange } = await createExchangeWithFirstRow();
      await expectCheckViolation(
        prisma.exchangeStatusHistory.create({
          data: {
            exchangeId: exchange.id,
            sequence: 2,
            fromStatus: 'DRAFT',
            toStatus: 'DRAFT',
            reason: 'noop',
          },
        }),
        'exchange_status_history_no_self_transition_check',
      );
    });

    it('UPDATE запрещён триггером', async () => {
      const { first } = await createExchangeWithFirstRow();
      await expect(
        prisma.exchangeStatusHistory.update({
          where: { id: first.id },
          data: { reason: 'tamper' },
        }),
      ).rejects.toThrow(/append-only/);
    });

    it('DELETE запрещён триггером', async () => {
      const { first } = await createExchangeWithFirstRow();
      await expect(
        prisma.exchangeStatusHistory.delete({ where: { id: first.id } }),
      ).rejects.toThrow(/append-only/);
    });

    it('TRUNCATE запрещён триггером', async () => {
      await expect(prisma.$executeRawUnsafe('TRUNCATE "exchange_status_history"')).rejects.toThrow(
        /append-only/,
      );
    });
  });

  describe('NotificationOutbox', () => {
    it('значения по умолчанию и json payload', async () => {
      const user = await createUser();
      const row = await prisma.notificationOutbox.create({
        data: {
          userId: user.id,
          type: 'EXCHANGE_STATUS_CHANGED',
          payload: { toStatus: 'FINISHED' },
          dedupeKey: randomUUID(),
        },
      });
      expect(row.status).toBe('PENDING');
      expect(row.attempts).toBe(0);
      expect(row.exchangeId).toBeNull();
      expect(row.payload).toEqual({ toStatus: 'FINISHED' });
    });

    it('dedupeKey уникален', async () => {
      const user = await createUser();
      const dedupeKey = randomUUID();
      const data = { userId: user.id, type: 'T', payload: {}, dedupeKey };
      await prisma.notificationOutbox.create({ data });
      await expectUniqueViolation(prisma.notificationOutbox.create({ data }));
    });

    it('SENT требует sentAt, PROCESSING требует lockedAt', async () => {
      const user = await createUser();
      const base = { userId: user.id, type: 'T', payload: {} };

      await expectCheckViolation(
        prisma.notificationOutbox.create({
          data: { ...base, dedupeKey: randomUUID(), status: 'SENT' },
        }),
        'notification_outbox_sent_check',
      );
      await expectCheckViolation(
        prisma.notificationOutbox.create({
          data: { ...base, dedupeKey: randomUUID(), status: 'PROCESSING' },
        }),
        'notification_outbox_processing_check',
      );

      await prisma.notificationOutbox.create({
        data: { ...base, dedupeKey: randomUUID(), status: 'SENT', sentAt: new Date() },
      });
      await prisma.notificationOutbox.create({
        data: { ...base, dedupeKey: randomUUID(), status: 'PROCESSING', lockedAt: new Date() },
      });
    });

    it('нельзя удалить пользователя с уведомлениями', async () => {
      const user = await createUser();
      await prisma.notificationOutbox.create({
        data: { userId: user.id, type: 'T', payload: {}, dedupeKey: randomUUID() },
      });
      await expectForeignKeyViolation(prisma.user.delete({ where: { id: user.id } }));
    });
  });
});
