/**
 * Чтение заявки для поддержки. Запросов на запись здесь нет.
 */
import { formatDecimal, parseDecimal } from '../../src/domain/shared/decimal-string.js';
import type { Prisma } from '../../src/database/generated/client.js';
import type { PrismaClient } from '../../src/database/prisma.js';
import {
  SUPPORT_LIST_LIMIT,
  type LookupHits,
  type SupportExchange,
  type SupportLookup,
  type UsernameHits,
} from './lookup.js';

type ExchangeRow = Prisma.ExchangeGetPayload<{ include: { user: true } }>;

export class PrismaSupportLookup implements SupportLookup {
  constructor(private readonly prisma: PrismaClient) {}

  async findById(id: string): Promise<SupportExchange | null> {
    const row = await this.prisma.exchange.findUnique({
      where: { id },
      include: { user: true },
    });
    return row === null ? null : toSupportExchange(row);
  }

  async findByProviderExchangeId(providerExchangeId: string): Promise<LookupHits> {
    const rows = await this.prisma.exchange.findMany({
      where: { providerExchangeId },
      select: { id: true },
      take: 2,
    });
    return this.oneOrMany(rows.map((row) => row.id));
  }

  async findByUsername(username: string): Promise<UsernameHits> {
    const users = await this.prisma.user.findMany({
      where: { username: { equals: username, mode: 'insensitive' } },
      select: { id: true },
    });
    if (users.length === 0) return { kind: 'none' };
    return this.listByUserIds(users.map((user) => user.id));
  }

  async findByTelegramId(telegramId: string): Promise<UsernameHits> {
    const user = await this.prisma.user.findUnique({
      where: { telegramId: BigInt(telegramId) },
      select: { id: true },
    });
    if (user === null) return { kind: 'none' };
    return this.listByUserIds([user.id]);
  }

  private async listByUserIds(userIds: readonly string[]): Promise<UsernameHits> {
    const rows = await this.prisma.exchange.findMany({
      where: { userId: { in: [...userIds] } },
      orderBy: { createdAt: 'desc' },
      take: SUPPORT_LIST_LIMIT + 1,
      select: {
        id: true,
        fromCurrency: true,
        fromNetwork: true,
        toCurrency: true,
        toNetwork: true,
        expectedFromAmount: true,
        status: true,
        createdAt: true,
        user: { select: { telegramId: true, username: true } },
      },
    });
    if (rows.length === 0) return { kind: 'empty' };
    return {
      kind: 'list',
      truncated: rows.length > SUPPORT_LIST_LIMIT,
      exchanges: rows.slice(0, SUPPORT_LIST_LIMIT).map((row) => ({
        id: row.id,
        fromCurrency: row.fromCurrency,
        fromNetwork: row.fromNetwork,
        toCurrency: row.toCurrency,
        toNetwork: row.toNetwork,
        expectedFromAmount: decimalToString(row.expectedFromAmount),
        status: row.status,
        createdAt: row.createdAt,
        telegramId: row.user.telegramId.toString(),
        username: row.user.username,
      })),
    };
  }

  async findByIdSuffix(suffix: string): Promise<LookupHits> {
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      SELECT id::text AS id
      FROM exchanges
      WHERE right(id::text, 8) = ${suffix}
      LIMIT 2`;
    return this.oneOrMany(rows.map((row) => row.id));
  }

  private async oneOrMany(ids: readonly string[]): Promise<LookupHits> {
    if (ids.length > 1) return { kind: 'many' };
    const id = ids[0];
    if (id === undefined) return { kind: 'none' };
    const exchange = await this.findById(id);
    return exchange === null ? { kind: 'none' } : { kind: 'one', exchange };
  }
}

function decimalToString(value: Prisma.Decimal): string {
  return formatDecimal(parseDecimal(value.toFixed()));
}

function toSupportExchange(row: ExchangeRow): SupportExchange {
  return {
    id: row.id,
    provider: row.provider,
    providerExchangeId: row.providerExchangeId,
    fromCurrency: row.fromCurrency,
    fromNetwork: row.fromNetwork,
    toCurrency: row.toCurrency,
    toNetwork: row.toNetwork,
    expectedFromAmount: decimalToString(row.expectedFromAmount),
    expectedToAmount: row.expectedToAmount === null ? null : decimalToString(row.expectedToAmount),
    actualFromAmount: row.actualFromAmount === null ? null : decimalToString(row.actualFromAmount),
    actualToAmount: row.actualToAmount === null ? null : decimalToString(row.actualToAmount),
    payinAddress: row.payinAddress,
    payinExtraId: row.payinExtraId,
    payoutAddress: row.payoutAddress,
    payoutExtraId: row.payoutExtraId,
    refundAddress: row.refundAddress,
    refundExtraId: row.refundExtraId,
    payinHash: row.payinHash,
    payoutHash: row.payoutHash,
    refundHash: row.refundHash,
    rateType: row.rateType,
    status: row.status,
    providerStatus: row.providerStatus,
    statusChangedAt: row.statusChangedAt,
    createdAt: row.createdAt,
    telegramId: row.user.telegramId.toString(),
    username: row.user.username,
  };
}
