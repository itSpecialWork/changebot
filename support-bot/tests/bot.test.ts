import { readFileSync } from 'node:fs';
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSupportBot } from '../src/bot.js';
import type { SupportExchange, SupportExchangeSummary, SupportLookup } from '../src/lookup.js';
import { createSupportLogger } from '../src/logger.js';

const USER = 1001;
const PASSWORD = 'support-test-password';
const TOKEN = '123456:TEST_TOKEN_FOR_UNIT_TESTS_ONLY_0000000';
const ID = '01932f8a-7b3c-7000-8000-00000000abcd';
const HIDDEN = 'hidden-payout-address';

interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

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
    payoutAddress: 'pay<out>',
    payoutExtraId: 'tag&1',
    refundAddress: null,
    refundExtraId: null,
    payinHash: null,
    payoutHash: 'hash-1',
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

describe('диалог бота поддержки', () => {
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
  const lookup: SupportLookup = {
    findById,
    findByProviderExchangeId,
    findByIdSuffix,
    findByUsername,
    findByTelegramId,
  };
  let now = 1_700_000_000_000;
  let bot: Bot;
  let calls: ApiCall[];
  let updateId = 0;

  beforeEach(async () => {
    vi.clearAllMocks();
    now = 1_700_000_000_000;
    calls = [];
    updateId = 0;
    bot = createSupportBot({
      token: TOKEN,
      password: PASSWORD,
      lookup,
      logger: createSupportLogger({ nodeEnv: 'test', logLevel: 'silent' }),
      now: () => now,
    });
    bot.api.config.use((_prev, method, payload) => {
      calls.push({ method, payload });
      const chat = { id: 1, type: 'private' as const };
      const result =
        method === 'getMe'
          ? { id: 1, is_bot: true, username: 'support', first_name: 'Support' }
          : { message_id: 1, date: 0, chat, text: 'sent' };
      return Promise.resolve({ ok: true, result } as never);
    });
    await bot.init();
    calls.length = 0;
  });

  async function sendText(text: string, chatType = 'private'): Promise<void> {
    updateId += 1;
    const update: Update = {
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 0,
        chat: { id: USER, type: chatType, first_name: 'Admin' } as never,
        from: { id: USER, is_bot: false, first_name: 'Admin' },
        text,
        ...(text.startsWith('/')
          ? {
              entities: [
                {
                  type: 'bot_command' as const,
                  offset: 0,
                  length: text.split(' ')[0]?.length ?? text.length,
                },
              ],
            }
          : {}),
      },
    };
    await bot.handleUpdate(update);
  }

  function texts(): string[] {
    return calls
      .filter((call) => call.method === 'sendMessage')
      .map((call) => String(call.payload.text));
  }

  function lastText(): string {
    const text = texts().at(-1);
    if (text === undefined) throw new Error('Бот ничего не ответил');
    return text;
  }

  it('молчит в групповом чате и не ищет заявку', async () => {
    await sendText(PASSWORD, 'group');

    expect(texts()).toEqual([]);
    expect(findById).not.toHaveBeenCalled();
  });

  it('неверный пароль не ищет заявку', async () => {
    await sendText(ID);

    expect(lastText()).toBe('Неверный пароль.');
    expect(findById).not.toHaveBeenCalled();
    expect(findByProviderExchangeId).not.toHaveBeenCalled();
    expect(findByIdSuffix).not.toHaveBeenCalled();
  });

  it('после пяти ошибок молчит 15 минут', async () => {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await sendText('wrong');
    }
    expect(lastText()).toBe('Неверный пароль.');

    const replies = texts().length;
    await sendText('wrong');
    expect(texts()).toHaveLength(replies);

    now += 15 * 60_000 - 1;
    await sendText(PASSWORD);
    expect(texts()).toHaveLength(replies);

    now += 1;
    await sendText(PASSWORD);
    expect(lastText()).toBe('Пришлите ID из квитанции, @username или Telegram ID.');
    expect(findById).not.toHaveBeenCalled();
  });

  it('после пароля показывает карточку и не предлагает сменить статус', async () => {
    findById.mockResolvedValueOnce(exchange());
    await sendText(PASSWORD);
    await sendText(ID);

    const text = lastText();
    expect(text).toContain('Заявка поддержки');
    expect(text).toContain('100.5');
    expect(text).toContain('pay&lt;out&gt;');
    expect(text).toContain('tag&amp;1');
    expect(text).toContain(ID);
    expect(text).toContain('1001');
    expect(text).not.toContain('Подтвердить');
    expect(text).not.toContain('Отменить');
    const last = calls.filter((call) => call.method === 'sendMessage').at(-1);
    expect(last?.payload.reply_markup).toBeUndefined();
    expect(findById).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('неоднозначный хвост не показывает чужой адрес', async () => {
    findByIdSuffix.mockResolvedValueOnce({ kind: 'many' });
    await sendText(PASSWORD);
    await sendText('abcd1234');

    expect(lastText()).toBe('Уточните полный ID из квитанции.');
    expect(lastText()).not.toContain(HIDDEN);
  });

  it('после выхода ID снова считается паролем', async () => {
    await sendText(PASSWORD);
    await sendText('/logout');
    await sendText(ID);

    expect(lastText()).toBe('Неверный пароль.');
    expect(findById).not.toHaveBeenCalled();
  });

  it('@username показывает список заявок без адресов', async () => {
    const hidden = 'secret-payout-address';
    const first: SupportExchangeSummary = {
      id: ID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      expectedFromAmount: '100.5',
      status: 'FINISHED',
      createdAt: new Date('2026-10-14T12:00:00Z'),
      telegramId: '1001',
      username: 'alice',
    };
    const second: SupportExchangeSummary = {
      ...first,
      id: '01932f8a-7b3c-7000-8000-00000000abce',
      expectedFromAmount: '50',
      status: 'WAITING_DEPOSIT',
      createdAt: new Date('2026-10-13T12:00:00Z'),
    };
    findByUsername.mockResolvedValueOnce({
      kind: 'list',
      truncated: false,
      exchanges: [first, second],
    });

    await sendText(PASSWORD);
    await sendText('@alice');

    const text = lastText();
    expect(text).toContain('Заявки @alice');
    expect(text).toContain(ID);
    expect(text).toContain(second.id);
    expect(text).toContain('100.5');
    expect(text).toContain('50');
    expect(text).toContain('Завершён');
    expect(text).toContain('Ожидаем платёж');
    expect(text).not.toContain(hidden);
    expect(text).not.toContain('Депозит');
    expect(findById).not.toHaveBeenCalled();
  });

  it('Telegram ID показывает список, а не «заявка не найдена»', async () => {
    findByTelegramId.mockResolvedValueOnce({
      kind: 'list',
      truncated: true,
      exchanges: [
        {
          id: ID,
          fromCurrency: 'usdt',
          fromNetwork: 'trx',
          toCurrency: 'btc',
          toNetwork: 'btc',
          expectedFromAmount: '100.5',
          status: 'FINISHED',
          createdAt: new Date('2026-10-14T12:00:00Z'),
          telegramId: '8368526613',
          username: 'oralCumshoting',
        },
      ],
    });
    await sendText(PASSWORD);
    await sendText('8368526613');

    const text = lastText();
    expect(text).toContain('Заявки @oralCumshoting');
    expect(text).toContain('Показаны 20 последних.');
    expect(text).not.toBe('Заявка не найдена.');
    expect(findById).not.toHaveBeenCalled();
  });

  it('после списка ID открывает карточку', async () => {
    findByUsername.mockResolvedValueOnce({ kind: 'empty' });
    findById.mockResolvedValueOnce(exchange());
    await sendText(PASSWORD);
    await sendText('@alice');
    expect(lastText()).toBe('Заявок у этого пользователя нет.');

    await sendText(ID);
    expect(lastText()).toContain('pay&lt;out&gt;');
    expect(findById).toHaveBeenCalledExactlyOnceWith(ID);
  });

  it('истекшая сессия не ищет заявку', async () => {
    await sendText(PASSWORD);
    now += 30 * 60_000;
    await sendText(ID);

    expect(lastText()).toBe('Сессия истекла. Введите пароль.');
    expect(findById).not.toHaveBeenCalled();
  });
});

describe('карточка не живёт в обменном боте', () => {
  it('текст карточки собирается в папке поддержки', () => {
    const source = readFileSync('support-bot/src/format.ts', 'utf8');
    expect(source).toContain('Заявка поддержки');
    expect(readFileSync('src/telegram/bot/format.ts', 'utf8')).not.toContain('Заявка поддержки');
  });
});
