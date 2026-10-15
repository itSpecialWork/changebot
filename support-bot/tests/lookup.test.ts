import { describe, expect, it, vi } from 'vitest';
import {
  findSupportExchange,
  type SupportExchange,
  type SupportExchangeSummary,
  type SupportLookup,
} from '../src/lookup.js';

const ID = '01932f8a-7b3c-7000-8000-00000000abcd';

function exchange(patch: Partial<SupportExchange> = {}): SupportExchange {
  return {
    id: ID,
    provider: 'CHANGENOW',
    providerExchangeId: 'provider-1',
    fromCurrency: 'usdt',
    fromNetwork: 'trx',
    toCurrency: 'btc',
    toNetwork: 'btc',
    expectedFromAmount: '100.5',
    expectedToAmount: '0.001',
    actualFromAmount: null,
    actualToAmount: null,
    payinAddress: 'payin-addr',
    payinExtraId: null,
    payoutAddress: 'payout-addr',
    payoutExtraId: 'memo-1',
    refundAddress: null,
    refundExtraId: null,
    payinHash: null,
    payoutHash: null,
    refundHash: null,
    rateType: 'FIXED',
    status: 'WAITING_DEPOSIT',
    providerStatus: 'waiting',
    statusChangedAt: new Date('2026-10-14T12:00:00Z'),
    createdAt: new Date('2026-10-14T11:00:00Z'),
    telegramId: '1001',
    username: 'alice',
    ...patch,
  };
}

function spies() {
  const findById = vi.fn<SupportLookup['findById']>(() => Promise.resolve(null));
  const findByProviderExchangeId = vi.fn<SupportLookup['findByProviderExchangeId']>(() =>
    Promise.resolve({ kind: 'none' }),
  );
  const findByIdSuffix = vi.fn<SupportLookup['findByIdSuffix']>(() =>
    Promise.resolve({ kind: 'none' }),
  );
  const findByUsername = vi.fn<SupportLookup['findByUsername']>(() =>
    Promise.resolve({ kind: 'none' }),
  );
  const findByTelegramId = vi.fn<SupportLookup['findByTelegramId']>(() =>
    Promise.resolve({ kind: 'none' }),
  );
  return {
    source: {
      findById,
      findByProviderExchangeId,
      findByIdSuffix,
      findByUsername,
      findByTelegramId,
    },
    findById,
    findByProviderExchangeId,
    findByIdSuffix,
    findByUsername,
    findByTelegramId,
  };
}

describe('findSupportExchange', () => {
  it('полный UUID ищет только внутренний id', async () => {
    const found = exchange();
    const { source, findById, findByProviderExchangeId, findByIdSuffix } = spies();
    findById.mockResolvedValueOnce(found);

    await expect(findSupportExchange(source, `  ${ID.toUpperCase()}  `)).resolves.toEqual({
      kind: 'found',
      exchange: found,
    });
    expect(findById).toHaveBeenCalledTimes(1);
    expect(findById).toHaveBeenCalledWith(ID);
    expect(findByProviderExchangeId).not.toHaveBeenCalled();
    expect(findByIdSuffix).not.toHaveBeenCalled();
  });

  it('id провайдера важнее хвоста из 8 символов', async () => {
    const found = exchange();
    const { source, findByProviderExchangeId, findByIdSuffix } = spies();
    findByProviderExchangeId.mockResolvedValueOnce({ kind: 'one', exchange: found });

    await expect(findSupportExchange(source, 'abcd1234')).resolves.toEqual({
      kind: 'found',
      exchange: found,
    });
    expect(findByIdSuffix).not.toHaveBeenCalled();
  });

  it('неоднозначный хвост не отдаёт заявки', async () => {
    const { source, findByIdSuffix } = spies();
    findByIdSuffix.mockResolvedValueOnce({ kind: 'many' });

    await expect(findSupportExchange(source, 'ABCD1234')).resolves.toEqual({ kind: 'ambiguous' });
    expect(findByIdSuffix).toHaveBeenCalledTimes(1);
    expect(findByIdSuffix).toHaveBeenCalledWith('abcd1234');
  });

  it('уникальный хвост возвращает одну заявку', async () => {
    const found = exchange();
    const { source, findByIdSuffix } = spies();
    findByIdSuffix.mockResolvedValueOnce({ kind: 'one', exchange: found });

    await expect(findSupportExchange(source, '0000abcd')).resolves.toEqual({
      kind: 'found',
      exchange: found,
    });
  });

  it('@username отдаёт список и не ищет заявку по id', async () => {
    const summary: SupportExchangeSummary = {
      id: ID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      expectedFromAmount: '100.5',
      status: 'FINISHED',
      createdAt: new Date('2026-10-14T11:00:00Z'),
      telegramId: '1001',
      username: 'alice',
    };
    const { source, findById, findByUsername } = spies();
    findByUsername.mockResolvedValueOnce({
      kind: 'list',
      truncated: false,
      exchanges: [summary],
    });

    await expect(findSupportExchange(source, '@Alice')).resolves.toEqual({
      kind: 'list',
      username: 'alice',
      truncated: false,
      exchanges: [summary],
    });
    expect(findByUsername).toHaveBeenCalledWith('Alice');
    expect(findById).not.toHaveBeenCalled();
  });

  it('числовой Telegram ID отдаёт список заявок', async () => {
    const summary: SupportExchangeSummary = {
      id: ID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      expectedFromAmount: '100.5',
      status: 'FINISHED',
      createdAt: new Date('2026-10-14T11:00:00Z'),
      telegramId: '8368526613',
      username: 'alice',
    };
    const { source, findById, findByTelegramId, findByProviderExchangeId } = spies();
    findByTelegramId.mockResolvedValueOnce({
      kind: 'list',
      truncated: false,
      exchanges: [summary],
    });

    await expect(findSupportExchange(source, '8368526613')).resolves.toEqual({
      kind: 'list',
      username: 'alice',
      truncated: false,
      exchanges: [summary],
    });
    expect(findByTelegramId).toHaveBeenCalledWith('8368526613');
    expect(findById).not.toHaveBeenCalled();
    expect(findByProviderExchangeId).not.toHaveBeenCalled();
  });

  it('короткое имя после @ не ищет пользователя', async () => {
    const { source, findByUsername } = spies();

    await expect(findSupportExchange(source, '@ab')).resolves.toEqual({
      kind: 'invalid-username',
    });
    expect(findByUsername).not.toHaveBeenCalled();
  });
});
