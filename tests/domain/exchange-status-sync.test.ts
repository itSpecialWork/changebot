import { describe, expect, it } from 'vitest';
import {
  ExchangeProvider as PrismaProvider,
  ExchangeStatus as PrismaExchangeStatus,
  RateType as PrismaRateType,
} from '../../src/database/generated/enums.js';
import { EXCHANGE_PROVIDER_KINDS } from '../../src/domain/exchanges/exchange.js';
import {
  PROVIDER_EXCHANGE_STATUSES,
  RATE_TYPES,
} from '../../src/domain/exchanges/exchange-provider.js';
import {
  EXCHANGE_STATUSES,
  getAllowedTransitions,
} from '../../src/domain/exchanges/status-transitions.js';

describe('ExchangeStatus: домен и Prisma enum', () => {
  it('списки статусов совпадают', () => {
    expect([...EXCHANGE_STATUSES].sort()).toEqual(Object.values(PrismaExchangeStatus).sort());
  });
});

describe('ExchangeProvider: домен и Prisma enum', () => {
  it('списки провайдеров совпадают', () => {
    expect([...EXCHANGE_PROVIDER_KINDS].sort()).toEqual(Object.values(PrismaProvider).sort());
  });
});

describe('RateType: домен и Prisma enum', () => {
  it('списки типов курса совпадают', () => {
    expect([...RATE_TYPES].sort()).toEqual(Object.values(PrismaRateType).sort());
  });
});

describe('Статусы, возвращаемые провайдером', () => {
  it('совпадают со статусами, достижимыми из WAITING_DEPOSIT', () => {
    const reachable = ['WAITING_DEPOSIT', ...getAllowedTransitions('WAITING_DEPOSIT')];
    expect([...PROVIDER_EXCHANGE_STATUSES].sort()).toEqual([...reachable].sort());
  });
});
