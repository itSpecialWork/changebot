import type { UserRepository } from '../../application/users/user-repository.js';
import type { TelegramProfile, UserRecord } from '../../domain/users/user.js';
import { Prisma, type User } from '../generated/client.js';
import type { PrismaClient } from '../prisma.js';

function toRecord(row: User): UserRecord {
  return {
    id: row.id,
    telegramId: row.telegramId,
    username: row.username,
    firstName: row.firstName,
    languageCode: row.languageCode,
    botBlockedAt: row.botBlockedAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isUnchanged(row: User, profile: TelegramProfile): boolean {
  return (
    row.botBlockedAt === null &&
    row.username === profile.username &&
    row.firstName === profile.firstName &&
    row.languageCode === profile.languageCode
  );
}

export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async upsertFromTelegram(profile: TelegramProfile): Promise<UserRecord> {
    const existing = await this.prisma.user.findUnique({
      where: { telegramId: profile.telegramId },
    });
    if (existing && isUnchanged(existing, profile)) {
      return toRecord(existing);
    }

    const fields = {
      username: profile.username,
      firstName: profile.firstName,
      languageCode: profile.languageCode,
    };
    try {
      const row = await this.prisma.user.upsert({
        where: { telegramId: profile.telegramId },
        create: { telegramId: profile.telegramId, ...fields },
        update: { ...fields, botBlockedAt: null },
      });
      return toRecord(row);
    } catch (error) {
      // Параллельный первый запрос того же пользователя успел создать запись раньше.
      if (!isUniqueViolation(error)) throw error;
      const row = await this.prisma.user.update({
        where: { telegramId: profile.telegramId },
        data: { ...fields, botBlockedAt: null },
      });
      return toRecord(row);
    }
  }
}
