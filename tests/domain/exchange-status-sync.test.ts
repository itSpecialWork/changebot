import { describe, expect, it } from 'vitest';
import { ExchangeStatus as PrismaExchangeStatus } from '../../src/database/generated/enums.js';
import { EXCHANGE_STATUSES } from '../../src/domain/exchanges/status-transitions.js';

describe('ExchangeStatus: домен и Prisma enum', () => {
  it('списки статусов совпадают', () => {
    expect([...EXCHANGE_STATUSES].sort()).toEqual(Object.values(PrismaExchangeStatus).sort());
  });
});
