/**
 * Интеграционные тесты PrismaUserRepository и listByUser (нужна TEST_DATABASE_URL).
 */
import { randomInt, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NewDraft } from '../../src/application/exchanges/exchange-repository.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import { PrismaExchangeRepository } from '../../src/database/repositories/prisma-exchange-repository.js';
import { PrismaUserRepository } from '../../src/database/repositories/prisma-user-repository.js';
import { createTestUser, setupTestDatabase, testDatabaseUrl } from './test-database.js';

function newTelegramId(): bigint {
  return BigInt(randomInt(1, 2 ** 31)) * 10_000n + 7n;
}

function draft(userId: string, amount: string): NewDraft {
  return {
    userId,
    provider: 'MOCK',
    idempotencyKey: randomUUID(),
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    expectedFromAmount: amount,
    payoutAddress: 'test-payout-address',
    payoutExtraId: null,
    refundAddress: null,
    refundExtraId: null,
    rateType: 'FLOATING',
    nextCheckAt: new Date('2026-01-01T01:00:00.000Z'),
  };
}

describe.skipIf(!testDatabaseUrl)('PrismaUserRepository', () => {
  let prisma: PrismaClient;
  let users: PrismaUserRepository;

  beforeAll(() => {
    prisma = setupTestDatabase();
    users = new PrismaUserRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('создаёт пользователя при первом обращении', async () => {
    const telegramId = newTelegramId();

    const user = await users.upsertFromTelegram({
      telegramId,
      username: 'tester',
      firstName: 'Тест',
      languageCode: 'ru',
    });

    expect(user).toMatchObject({
      telegramId,
      username: 'tester',
      firstName: 'Тест',
      languageCode: 'ru',
      botBlockedAt: null,
    });
  });

  it('повторный вызов возвращает того же пользователя и не пишет без изменений', async () => {
    const profile = {
      telegramId: newTelegramId(),
      username: 'a',
      firstName: 'A',
      languageCode: 'en',
    };
    const first = await users.upsertFromTelegram(profile);
    const before = await prisma.user.findUniqueOrThrow({ where: { id: first.id } });

    const second = await users.upsertFromTelegram(profile);
    const after = await prisma.user.findUniqueOrThrow({ where: { id: first.id } });

    expect(second.id).toBe(first.id);
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it('обновляет профиль', async () => {
    const telegramId = newTelegramId();
    const first = await users.upsertFromTelegram({
      telegramId,
      username: 'old',
      firstName: 'Old',
      languageCode: null,
    });

    const updated = await users.upsertFromTelegram({
      telegramId,
      username: null,
      firstName: 'New',
      languageCode: 'ru',
    });

    expect(updated).toMatchObject({
      id: first.id,
      username: null,
      firstName: 'New',
      languageCode: 'ru',
    });
  });

  it('сбрасывает botBlockedAt при новом обращении пользователя', async () => {
    const profile = {
      telegramId: newTelegramId(),
      username: null,
      firstName: 'B',
      languageCode: null,
    };
    const user = await users.upsertFromTelegram(profile);
    await prisma.user.update({ where: { id: user.id }, data: { botBlockedAt: new Date() } });

    const again = await users.upsertFromTelegram(profile);

    expect(again.botBlockedAt).toBeNull();
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.botBlockedAt).toBeNull();
  });

  it('параллельная регистрация одного Telegram ID даёт одну запись', async () => {
    const profile = {
      telegramId: newTelegramId(),
      username: null,
      firstName: 'P',
      languageCode: null,
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => users.upsertFromTelegram(profile)),
    );

    expect(new Set(results.map((u) => u.id)).size).toBe(1);
    expect(await prisma.user.count({ where: { telegramId: profile.telegramId } })).toBe(1);
  });
});

describe.skipIf(!testDatabaseUrl)('PrismaExchangeRepository.listByUser', () => {
  let prisma: PrismaClient;
  let repository: PrismaExchangeRepository;

  beforeAll(() => {
    prisma = setupTestDatabase();
    repository = new PrismaExchangeRepository(prisma);
  }, 120_000);

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('возвращает только обмены пользователя, новые первыми, с лимитом', async () => {
    const owner = await createTestUser(prisma);
    const stranger = await createTestUser(prisma);
    const ids: string[] = [];
    for (const amount of ['1', '2', '3']) {
      ids.push((await repository.createDraft(draft(owner.id, amount))).exchange.id);
    }
    await repository.createDraft(draft(stranger.id, '9'));

    const all = await repository.listByUser(owner.id, 10);
    const limited = await repository.listByUser(owner.id, 2);

    expect(all.map((e) => e.id)).toEqual([...ids].reverse());
    expect(limited.map((e) => e.id)).toEqual([ids[2], ids[1]]);
    expect(await repository.listByUser(owner.id, 0)).toEqual([]);
  });
});
