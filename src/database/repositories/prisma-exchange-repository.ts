import {
  ExchangeNotFoundError,
  ExchangeStatusConflictError,
} from '../../application/exchanges/errors.js';
import type {
  CheckFailureParams,
  ClaimDueParams,
  CheckSuccessParams,
  ExchangePatch,
  ExchangeRepository,
  NewDraft,
  TransitionParams,
} from '../../application/exchanges/exchange-repository.js';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import type { ExchangeStatus } from '../../domain/exchanges/status-transitions.js';
import { formatDecimal, parseDecimal } from '../../domain/shared/decimal-string.js';
import { Prisma, type Exchange } from '../generated/client.js';
import type { PrismaClient } from '../prisma.js';

/** Десятичное значение БД в строку без экспоненты и лишних нулей. */
function decimalToString(value: Prisma.Decimal): string {
  return formatDecimal(parseDecimal(value.toFixed()));
}

function toRecord(row: Exchange): ExchangeRecord {
  return {
    id: row.id,
    userId: row.userId,
    provider: row.provider,
    providerExchangeId: row.providerExchangeId,
    idempotencyKey: row.idempotencyKey,
    fromCurrency: row.fromCurrency,
    fromNetwork: row.fromNetwork,
    toCurrency: row.toCurrency,
    toNetwork: row.toNetwork,
    expectedFromAmount: decimalToString(row.expectedFromAmount),
    expectedToAmount: row.expectedToAmount && decimalToString(row.expectedToAmount),
    actualFromAmount: row.actualFromAmount && decimalToString(row.actualFromAmount),
    actualToAmount: row.actualToAmount && decimalToString(row.actualToAmount),
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
    providerRateId: row.providerRateId,
    quoteExpiresAt: row.quoteExpiresAt,
    status: row.status,
    providerStatus: row.providerStatus,
    statusChangedAt: row.statusChangedAt,
    nextCheckAt: row.nextCheckAt,
    lastCheckedAt: row.lastCheckedAt,
    checkFailureCount: row.checkFailureCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * Имена полей ExchangePatch совпадают с полями модели Exchange, поэтому патч можно
 * передать в Prisma как есть, отбросив undefined (exactOptionalPropertyTypes).
 */
function patchToData(patch: ExchangePatch): Prisma.ExchangeUncheckedUpdateManyInput {
  return Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined));
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class PrismaExchangeRepository implements ExchangeRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async createDraft(draft: NewDraft): Promise<{ exchange: ExchangeRecord; created: boolean }> {
    const existing = await this.findByIdempotencyKey(draft.idempotencyKey);
    if (existing) {
      return { exchange: existing, created: false };
    }

    try {
      // Обмен и первая запись истории создаются одной атомарной операцией.
      const row = await this.prisma.exchange.create({
        data: {
          ...draft,
          status: 'DRAFT',
          statusHistory: {
            create: { sequence: 1, fromStatus: null, toStatus: 'DRAFT', reason: 'draft_created' },
          },
        },
      });
      return { exchange: toRecord(row), created: true };
    } catch (error) {
      // Параллельный запрос с тем же ключом успел раньше.
      if (isUniqueViolation(error)) {
        const winner = await this.findByIdempotencyKey(draft.idempotencyKey);
        if (winner) {
          return { exchange: winner, created: false };
        }
      }
      throw error;
    }
  }

  async findById(exchangeId: string): Promise<ExchangeRecord | null> {
    const row = await this.prisma.exchange.findUnique({ where: { id: exchangeId } });
    return row && toRecord(row);
  }

  async listByUser(userId: string, limit: number): Promise<ExchangeRecord[]> {
    if (limit <= 0) return [];
    const rows = await this.prisma.exchange.findMany({
      where: { userId },
      // id (UUIDv7) разрешает совпадения createdAt детерминированно.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map(toRecord);
  }

  async transition(params: TransitionParams): Promise<ExchangeRecord> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.exchange.updateMany({
        where: { id: params.exchangeId, status: params.from },
        data: {
          ...patchToData(params.patch ?? {}),
          status: params.to,
          statusChangedAt: params.at,
          nextCheckAt: params.nextCheckAt,
          checkFailureCount: 0,
        },
      });
      if (result.count === 0) {
        throw await this.explainMiss(tx, params.exchangeId, params.from);
      }

      const updated = await tx.exchange.findUniqueOrThrow({ where: { id: params.exchangeId } });
      // Статус обновлён строкой выше и удерживается блокировкой до конца транзакции,
      // поэтому параллельный переход не может занять тот же sequence.
      const last = await tx.exchangeStatusHistory.findFirst({
        where: { exchangeId: params.exchangeId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const historyEntry = await tx.exchangeStatusHistory.create({
        data: {
          exchangeId: params.exchangeId,
          sequence: (last?.sequence ?? 0) + 1,
          fromStatus: params.from,
          toStatus: params.to,
          providerStatus: updated.providerStatus,
          reason: params.reason,
        },
        select: { id: true },
      });
      if (params.notification) {
        await tx.notificationOutbox.create({
          data: {
            userId: updated.userId,
            exchangeId: updated.id,
            type: params.notification.type,
            payload: params.notification.payload,
            dedupeKey: `exchange:${updated.id}:history:${historyEntry.id}`,
            nextAttemptAt: params.at,
          },
        });
      }
      return toRecord(updated);
    });
  }

  async recordCheckFailure(params: CheckFailureParams): Promise<ExchangeRecord> {
    return this.updateWithoutTransition(params.exchangeId, params.expectedStatus, {
      checkFailureCount: { increment: 1 },
      lastCheckedAt: params.at,
      nextCheckAt: params.nextCheckAt,
    });
  }

  async recordCheckSuccess(params: CheckSuccessParams): Promise<ExchangeRecord> {
    return this.updateWithoutTransition(params.exchangeId, params.expectedStatus, {
      checkFailureCount: 0,
      lastCheckedAt: params.at,
      nextCheckAt: params.nextCheckAt,
      providerStatus: params.providerStatus,
      ...(params.payinHash !== undefined ? { payinHash: params.payinHash } : {}),
      ...(params.payoutHash !== undefined ? { payoutHash: params.payoutHash } : {}),
      ...(params.refundHash !== undefined ? { refundHash: params.refundHash } : {}),
    });
  }

  async claimDueForProviderCheck(params: ClaimDueParams): Promise<string[]> {
    if (params.statuses.length === 0 || params.limit <= 0) return [];
    // Все значения передаются параметрами. SKIP LOCKED: параллельные worker не ждут друг друга
    // и не получают одну и ту же строку.
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE exchanges
      SET next_check_at = ${params.leaseUntil}::timestamptz,
          updated_at = ${params.now}::timestamptz
      WHERE id IN (
        SELECT id FROM exchanges
        WHERE status = ANY(${[...params.statuses]}::text[]::exchange_status[])
          AND provider = ${params.provider}::text::exchange_provider
          AND provider_exchange_id IS NOT NULL
          AND next_check_at <= ${params.now}::timestamptz
        ORDER BY next_check_at ASC
        LIMIT ${params.limit}::int
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id::text AS id`;
    return rows.map((row) => row.id);
  }

  /** Обновление без смены статуса: тоже compare-and-set, истории не пишет. */
  private async updateWithoutTransition(
    exchangeId: string,
    expectedStatus: ExchangeStatus,
    data: Prisma.ExchangeUncheckedUpdateManyInput,
  ): Promise<ExchangeRecord> {
    return this.prisma.$transaction(async (tx) => {
      const result = await tx.exchange.updateMany({
        where: { id: exchangeId, status: expectedStatus },
        data,
      });
      if (result.count === 0) {
        throw await this.explainMiss(tx, exchangeId, expectedStatus);
      }
      return toRecord(await tx.exchange.findUniqueOrThrow({ where: { id: exchangeId } }));
    });
  }

  private async findByIdempotencyKey(idempotencyKey: string): Promise<ExchangeRecord | null> {
    const row = await this.prisma.exchange.findUnique({ where: { idempotencyKey } });
    return row && toRecord(row);
  }

  private async explainMiss(
    tx: Prisma.TransactionClient,
    exchangeId: string,
    expected: ExchangeStatus,
  ): Promise<Error> {
    const row = await tx.exchange.findUnique({
      where: { id: exchangeId },
      select: { status: true },
    });
    return row
      ? new ExchangeStatusConflictError(exchangeId, expected, row.status)
      : new ExchangeNotFoundError(exchangeId);
  }
}
