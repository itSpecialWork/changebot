/**
 * Общая подготовка тестовой БД для интеграционных тестов.
 * Работает только с базой, имя которой оканчивается на `_test`.
 */
import { execFileSync } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { createPrismaClient, type PrismaClient } from '../../src/database/prisma.js';

export const testDatabaseUrl = process.env.TEST_DATABASE_URL;

export function setupTestDatabase(): PrismaClient {
  if (!testDatabaseUrl) throw new Error('TEST_DATABASE_URL is not set');
  const dbName = new URL(testDatabaseUrl).pathname.replace(/^\//, '');
  if (!dbName.endsWith('_test')) {
    throw new Error('TEST_DATABASE_URL must point to a database whose name ends with "_test"');
  }
  execFileSync('npx', ['prisma', 'migrate', 'deploy'], {
    env: { ...process.env, DATABASE_URL: testDatabaseUrl },
    stdio: 'pipe',
  });
  return createPrismaClient(testDatabaseUrl);
}

/** Создаёт пользователя с уникальным telegramId (данные между тестами не очищаются). */
export function createTestUser(prisma: PrismaClient): Promise<{ id: string }> {
  return prisma.user.create({
    data: { telegramId: BigInt(randomInt(1, 2 ** 31)) * 10_000n + 3n },
    select: { id: true },
  });
}
