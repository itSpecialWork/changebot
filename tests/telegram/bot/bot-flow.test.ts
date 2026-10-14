import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_MOCK_CURRENCIES,
  DEFAULT_MOCK_RATES,
  MockExchangeProvider,
} from '../../../src/integrations/mock/mock-exchange-provider.js';
import type { ProviderCurrency } from '../../../src/domain/exchanges/exchange-provider.js';
import { BotHarness } from './harness.js';

const USER = 1001;
const OTHER_USER = 2002;
const ADDRESS = 'mock-payout-address-1';

let bot: BotHarness;

beforeEach(async () => {
  bot = await BotHarness.create();
});

/** Проходит диалог до карточки подтверждения (USDT trx → BTC, фиксированный курс, 100). */
async function reachConfirmation(userId = USER): Promise<string> {
  await bot.pressButton(userId, 'm:new');
  await bot.pressButton(userId, 'f:usdt:trx');
  await bot.pressButton(userId, 'u:a');
  await bot.pressButton(userId, 't:btc:btc');
  await bot.sendText(userId, '100');
  await bot.sendText(userId, ADDRESS);
  const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
  if (!confirm) throw new Error('Confirm button is missing');
  return confirm;
}

describe('бот: меню', () => {
  it('/start показывает меню с тестовым баннером и регистрирует пользователя', async () => {
    await bot.sendText(USER, '/start');

    expect(bot.lastText()).toContain('Тестовый режим');
    expect(bot.lastButtons()).toEqual(
      expect.arrayContaining(['m:new', 'm:list', 'm:help', 'm:sup', 'm:agr']),
    );
    expect(bot.userRepository.users.has(String(USER))).toBe(true);
  });

  it('игнорирует сообщения из групповых чатов', async () => {
    await bot.sendText(USER, '/start', 'group');

    expect(bot.calls.filter((c) => c.method === 'sendMessage')).toHaveLength(0);
    expect(bot.userRepository.users.size).toBe(0);
  });

  it('на неожиданный текст отвечает подсказкой с меню', async () => {
    await bot.sendText(USER, 'привет');

    expect(bot.lastText()).toContain('Не понял');
    expect(bot.lastButtons()).toContain('m:new');
  });

  it('неизвестная кнопка возвращает в меню', async () => {
    await bot.pressButton(USER, 'garbage');

    expect(bot.lastButtons()).toContain('m:new');
  });

  it('пустой список обменов', async () => {
    await bot.pressButton(USER, 'm:list');

    expect(bot.lastText()).toContain('пока нет обменов');
  });

  it('справка описывает монету, сеть, меню «/» и автоматический курс', async () => {
    await bot.pressButton(USER, 'm:help');

    const text = bot.lastText();
    expect(text).toContain('монету и сеть');
    expect(text).toContain('/usdt_trc20');
    expect(text).toContain('курс при этом фиксированный');
    expect(text).toContain('«Отправить» — сумма, которую отдаёте');
    expect(text).toContain('«Получить» — сумма, которая должна прийти');
    expect(text).not.toContain('которую получит адресат');
    expect(text).not.toContain('Выберите тип курса');
    expect(text).toContain('/start, /menu, /exchanges, /help');
  });

  it('поддержка показывает почту и ссылку на Telegram', async () => {
    await bot.pressButton(USER, 'm:sup');

    const text = bot.lastText();
    expect(text).toContain('Служба поддержки');
    expect(text).toContain('напишите сюда');
    expect(text).toContain('support@example.com');
    expect(text).toContain('https://t.me/your_support');
    expect(text).toContain('@your_support');
    expect(bot.lastButtons()).toEqual(['m:menu']);
  });

  it('соглашения открывают три коротких раздела', async () => {
    await bot.pressButton(USER, 'm:agr');

    expect(bot.lastText()).toContain('Соглашения');
    expect(bot.lastButtons()).toEqual(['m:use', 'm:rsk', 'm:dat', 'm:menu']);

    await bot.pressButton(USER, 'm:use');
    expect(bot.lastText()).toContain('Условия обмена');
    expect(bot.lastText()).toContain('seed-фразы');
    expect(bot.lastButtons()).toEqual(['m:agr', 'm:menu']);

    await bot.pressButton(USER, 'm:rsk');
    expect(bot.lastText()).toContain('Риски');
    expect(bot.lastText()).toContain('Служба поддержки');

    await bot.pressButton(USER, 'm:dat');
    expect(bot.lastText()).toContain('Какие данные храним');
    expect(bot.lastText()).toContain('seed-фразы');
  });
});

describe('бот: создание обмена', () => {
  it('ведёт от выбора валют до карточки подтверждения', async () => {
    const confirm = await reachConfirmation();

    const text = bot.lastText();
    expect(text).toContain('Ждёт вашего подтверждения');
    expect(text).toContain('100 USDT (trx)');
    expect(text).toContain('0.0016 BTC');
    expect(text).toContain('Курс: фиксированный');
    expect(text).toContain(ADDRESS);
    expect(confirm).toMatch(/^c:[0-9a-f-]{36}$/);
    expect(bot.exchangeRepository.rows.size).toBe(1);
  });

  it('подтверждение создаёт обмен и показывает инструкцию по оплате', async () => {
    const confirm = await reachConfirmation();

    await bot.pressButton(USER, confirm);

    const text = bot.lastText();
    expect(text).toContain('Квитанция');
    expect(text).toContain('В ожидании');
    expect(text).toContain(ADDRESS);
    expect(text).toContain(`ID: <code>${confirm.slice(2)}</code>`);
    expect(text).toContain('mock-payin-address-');
    expect(text).toContain('Тестовый режим');
    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.status).toBe('WAITING_DEPOSIT');
  });

  it('повторное нажатие «Подтвердить» не создаёт второй обмен у провайдера', async () => {
    const confirm = await reachConfirmation();
    await bot.pressButton(USER, confirm);

    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('уже обработан');
    expect([...bot.exchangeRepository.rows.values()][0]?.status).toBe('WAITING_DEPOSIT');
  });

  it('отмена закрывает обмен до создания у провайдера', async () => {
    const confirm = await reachConfirmation();
    const exchangeId = confirm.slice(2);

    await bot.pressButton(USER, `x:${exchangeId}`);

    expect(bot.lastText()).toContain('Обмен отменён');
    expect(bot.exchangeRepository.rows.get(exchangeId)?.status).toBe('EXPIRED');
    // Подтвердить отменённый обмен нельзя.
    await bot.pressButton(USER, confirm);
    expect(bot.exchangeRepository.rows.get(exchangeId)?.status).toBe('EXPIRED');
  });

  it('без поддержки фиксированного курса сразу берёт плавающий и не принимает старую кнопку', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:xrp:xrp');
    expect(bot.lastText()).toContain('Введите сумму');
    expect(bot.lastButtons()).not.toContain('r:F');
    expect(bot.lastButtons()).not.toContain('r:X');

    await bot.pressButton(USER, 'r:X');
    expect(bot.lastText()).toContain('устарела');
  });

  it('для валюты с необязательным memo ставит «Пропустить» рядом с отменой', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.sendText(USER, 'xlm');
    await bot.pressButton(USER, 't:xlm:xlm');
    await bot.sendText(USER, '10');
    await bot.sendText(USER, ADDRESS);

    expect(bot.lastText()).toContain('нажмите «Пропустить»');
    const markup = bot.last().payload.reply_markup as {
      inline_keyboard: { callback_data?: string }[][];
    };
    expect(markup.inline_keyboard.map((row) => row.map((button) => button.callback_data))).toEqual([
      ['s:skip', 'm:menu'],
    ]);

    await bot.pressButton(USER, 's:skip');

    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.payoutExtraId).toBeNull();
    expect(exchange?.toCurrency).toBe('xlm');
  });

  it('для валюты с обязательным memo запрашивает его', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:xrp:xrp');
    await bot.sendText(USER, '10');
    await bot.sendText(USER, ADDRESS);
    expect(bot.lastText()).toContain('нужен Memo/Tag');
    expect(bot.lastButtons()).not.toContain('s:skip');

    await bot.sendText(USER, '12345');

    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.payoutExtraId).toBe('12345');
    expect(exchange?.rateType).toBe('FLOATING');
    expect(bot.lastText()).toContain('Курс: плавающий');
    expect(bot.lastText()).toContain('Memo/Tag: <code>12345</code>');
  });

  it('просит ввести сумму заново при мусоре и выходе за лимиты', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');
    expect(bot.lastText()).toContain('Минимум: <b>0.0001</b>');
    expect(bot.lastText()).not.toContain('100</code>');

    await bot.sendText(USER, 'много');
    expect(bot.lastText()).toContain('Это не сумма');

    await bot.sendText(USER, '0.000001');
    expect(bot.lastText()).toContain('меньше минимума');

    await bot.sendText(USER, '5000000');
    expect(bot.lastText()).toContain('больше максимума');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('отклоняет некорректный адрес и не создаёт обмен', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');
    await bot.sendText(USER, '100');

    await bot.sendText(USER, '<script>alert(1)</script>');

    expect(bot.lastText()).toContain('некорректно');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('живой режим не принимает мусор вместо адреса SOL и пропускает похожую форму', async () => {
    const sol: ProviderCurrency = {
      ticker: 'sol',
      network: 'sol',
      name: 'Solana',
      extraId: 'none',
      supportsFixedRate: true,
      featured: false,
    };
    const live = await BotHarness.create({
      demo: false,
      provider: new MockExchangeProvider({
        currencies: [...DEFAULT_MOCK_CURRENCIES, sol],
        rates: { ...DEFAULT_MOCK_RATES, 'usdt:trx>sol:sol': '0.006' },
      }),
    });

    await live.pressButton(USER, 'm:new');
    await live.pressButton(USER, 'f:usdt:trx');
    await live.pressButton(USER, 't:sol:sol');
    await live.sendText(USER, '20');
    await live.sendText(USER, 'jhghghhghgfgdgdgdg');

    expect(live.lastText()).toContain('не похож на кошелёк');
    expect(live.lastText()).toContain('SOL');
    expect(live.exchangeRepository.rows.size).toBe(0);

    await live.sendText(USER, 'So11111111111111111111111111111111111111112');
    expect(live.lastText()).toContain('Куда придут средства');
    expect(live.lastText()).toContain('Сейчас сюда ничего не отправляйте.');
    expect(live.lastText()).toContain('So11111111111111111111111111111111111111112');
    expect(live.exchangeRepository.rows.size).toBe(1);
  });

  it('неподдерживаемая пара сообщается на шаге суммы, черновик не создаётся', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 'f:btc:btc');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:xrp:xrp');

    expect(bot.lastText()).toContain('недоступна');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('кнопка «Отмена» сбрасывает диалог', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');

    await bot.pressButton(USER, 'm:menu');
    await bot.pressButton(USER, 't:btc:btc');

    expect(bot.lastText()).toContain('устарела');
  });

  it('на подтверждении просроченной котировки просит начать новый обмен и не создаёт его у провайдера', async () => {
    const create = vi.spyOn(bot.provider, 'createExchange');
    const confirm = await reachConfirmation();
    const exchangeId = confirm.slice(2);
    const exchange = bot.exchangeRepository.rows.get(exchangeId);
    if (!exchange) throw new Error('Exchange is missing');
    bot.exchangeRepository.rows.set(exchangeId, {
      ...exchange,
      quoteExpiresAt: new Date(0),
    });

    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('Котировка истекла. Начните новый обмен.');
    expect(bot.exchangeRepository.rows.get(exchangeId)?.status).toBe('EXPIRED');
    expect(bot.exchangeRepository.rows.get(exchangeId)?.providerExchangeId).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('бот: мои обмены', () => {
  async function reachAddress(): Promise<void> {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');
    await bot.sendText(USER, '100');
  }

  it('показывает список и карточку, чужой обмен недоступен', async () => {
    const confirm = await reachConfirmation();
    const exchangeId = confirm.slice(2);

    await bot.pressButton(USER, 'm:list');
    expect(bot.lastButtons()).toContain(`o:${exchangeId}`);

    await bot.pressButton(USER, `o:${exchangeId}`);
    expect(bot.lastText()).toContain('USDT → BTC');

    await bot.pressButton(OTHER_USER, `o:${exchangeId}`);
    expect(bot.lastText()).toContain('Обмен не найден');
    await bot.pressButton(OTHER_USER, `c:${exchangeId}`);
    expect([...bot.exchangeRepository.rows.values()][0]?.status).toBe('AWAITING_CONFIRMATION');
  });

  it('на шаге адреса открывает список и предупреждает, что обмен ещё не создан', async () => {
    const confirm = await reachConfirmation();
    const exchangeId = confirm.slice(2);
    await reachAddress();

    await bot.pressButton(USER, 'm:list');

    expect(bot.lastText()).toContain('Жду адрес, обмен ещё не создан.');
    expect(bot.lastText()).toContain('Ваши обмены');
    expect(bot.lastButtons()).toEqual(expect.arrayContaining([`o:${exchangeId}`, 'm:go', 'm:xa']));
    expect(bot.exchangeRepository.rows.size).toBe(1);
  });

  it('«Продолжить» возвращает к вводу адреса и не создаёт обмен', async () => {
    await reachAddress();
    await bot.pressButton(USER, 'm:list');

    await bot.pressButton(USER, 'm:go');

    expect(bot.lastText()).toContain('Отправьте адрес кошелька');
    expect(bot.exchangeRepository.rows.size).toBe(0);

    await bot.sendText(USER, ADDRESS);
    expect(bot.exchangeRepository.rows.size).toBe(1);
  });

  it('«Отмена» снимает ожидание адреса, список остаётся', async () => {
    await reachAddress();
    await bot.pressButton(USER, 'm:list');

    await bot.pressButton(USER, 'm:xa');

    expect(bot.lastText()).toContain('пока нет обменов');
    expect(bot.lastText()).not.toContain('Жду адрес');
    await bot.sendText(USER, ADDRESS);
    expect(bot.lastText()).toContain('Не понял');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });
});

describe('бот: поиск валюты', () => {
  it('на шаге выбора ищет по тикеру и не сбрасывает диалог при пустом результате', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.sendText(USER, 'zzz');

    expect(bot.lastText()).toContain('Ничего не найдено');
    expect(bot.lastButtons()).toContain('m:menu');
    expect(bot.lastButtons()).not.toContain('f:btc:btc');

    await bot.sendText(USER, 'btc');

    expect(bot.lastText()).toContain('Совпадения');
    expect(bot.lastButtons()).toContain('f:btc');
    expect(bot.lastButtons()).not.toContain('f:btc:btc');
    expect(bot.lastButtons()).not.toContain('f:eth');
  });

  it('базовая пара выбирает сеть сразу, а USDT из всех валют открывает сети', async () => {
    await bot.pressButton(USER, 'm:new');
    expect(bot.lastButtons()).toContain('f:usdt:trx');
    expect(bot.lastButtons()).toContain('f:btc:btc');
    expect(bot.lastButtons()).not.toContain('f:usdt');
    expect(bot.lastText()).not.toContain('Выберите сеть');

    await bot.pressButton(USER, 'u:h');
    expect(bot.lastText()).toContain('Актуальные монеты');
    expect(bot.lastButtons()).toContain('f:usdt');
    expect(bot.lastButtons()).toContain('f:btc');
    expect(bot.lastButtons()).not.toContain('f:usdt:trx');

    await bot.pressButton(USER, 'f:btc');
    expect(bot.lastText()).toContain('Какую монету хотите получить');
    expect(bot.lastText()).not.toContain('Выберите сеть');
  });

  it('TRX не спрашивает сеть, а USDT из всех валют открывает её', async () => {
    const extra: ProviderCurrency[] = [
      {
        ticker: 'trx',
        network: 'trx',
        name: 'TRON',
        extraId: 'none',
        supportsFixedRate: true,
        featured: false,
      },
      {
        ticker: 'sol',
        network: 'sol',
        name: 'Solana',
        extraId: 'none',
        supportsFixedRate: true,
        featured: false,
      },
      {
        ticker: 'usdt',
        network: 'bsc',
        name: 'Tether (BEP20)',
        extraId: 'none',
        supportsFixedRate: true,
        featured: false,
      },
    ];
    const catalog = await BotHarness.create({
      provider: new MockExchangeProvider({ currencies: [...DEFAULT_MOCK_CURRENCIES, ...extra] }),
    });

    await catalog.pressButton(USER, 'm:new');
    expect(catalog.lastButtons()).toEqual(
      expect.arrayContaining(['f:usdt:trx', 'f:usdt:bsc', 'f:btc:btc', 'f:trx:trx', 'f:sol:sol']),
    );

    await catalog.pressButton(USER, 'f:trx:trx');
    expect(catalog.lastText()).toContain('Какую монету хотите получить');
    expect(catalog.lastText()).not.toContain('Выберите сеть');

    await catalog.pressButton(USER, 'm:new');
    await catalog.pressButton(USER, 'u:h');
    expect(catalog.lastButtons()).toContain('f:trx');
    expect(catalog.lastButtons()).toContain('f:usdt');
    expect(catalog.lastButtons()).not.toContain('f:trx:trx');

    await catalog.pressButton(USER, 'f:trx');
    expect(catalog.lastText()).not.toContain('Выберите сеть');

    await catalog.pressButton(USER, 'm:new');
    await catalog.pressButton(USER, 'u:h');
    await catalog.pressButton(USER, 'f:usdt');
    expect(catalog.lastText()).toContain('Выберите сеть');
    expect(catalog.lastButtons()).toEqual(
      expect.arrayContaining(['f:usdt:trx', 'f:usdt:bsc', 'u:b']),
    );
  });

  it('команда /btc выбирает монету так же, как кнопка', async () => {
    await bot.pressButton(USER, 'm:new');
    expect(bot.lastText()).toContain('<b>Отправить</b>');
    expect(bot.lastText()).toContain('<b>💸 Что вы отдаёте?</b>');
    expect(bot.lastText()).toContain('Эту монету вы отправите на обмен.');

    const menu = bot.calls.find((call) => call.method === 'setMyCommands');
    const commands = menu?.payload.commands as { command: string }[] | undefined;
    expect(commands?.map((command) => command.command)).toContain('btc');
    expect(commands?.map((command) => command.command)).toContain('xlm');

    await bot.sendText(USER, '/btc');

    const text = bot.lastText();
    const notice = bot
      .messages()
      .map((call) => String(call.payload.text))
      .find((line) => line.includes('Вы выбрали'));
    expect(notice).toContain('✅ Вы выбрали <b>BTC</b>.');
    expect(notice).toContain('следующую монету');
    expect(text).toContain('<blockquote>Отдаёте\n<b>BTC</b></blockquote>');
    expect(text).toContain('<b>🪙 Какую монету хотите получить?</b>');
    expect(text).toContain('На неё придёт обмен.');
    expect(text).toContain('Базовые пары — кнопками ниже.');
    expect(text).toContain('Нажмите «/» и введите тикер — появятся подсказки.');
    expect(text).toContain('Остальные монеты — кнопка «Все валюты».');
    expect(bot.lastButtons()).toContain('t:usdt:trx');
    expect(bot.lastButtons()).not.toContain('t:eth');
  });

  it('сбрасывает меню «/» на отмене, /start и после выбора пары', async () => {
    const resets = (): number =>
      bot.calls.filter((call) => call.method === 'deleteMyCommands').length;

    await bot.pressButton(USER, 'm:new');
    expect(bot.calls.some((call) => call.method === 'setMyCommands')).toBe(true);
    expect(resets()).toBe(0);

    await bot.sendText(USER, '/btc');
    expect(bot.lastText()).toContain('Какую монету хотите получить');
    expect(resets()).toBe(0);

    await bot.pressButton(USER, 'm:menu');
    expect(resets()).toBe(1);
    expect(bot.calls.find((call) => call.method === 'deleteMyCommands')?.payload).toEqual({
      scope: { type: 'chat', chat_id: USER },
    });

    await bot.pressButton(USER, 'm:new');
    await bot.sendText(USER, '/start');
    expect(resets()).toBe(2);
    expect(bot.lastButtons()).toContain('m:new');

    await bot.pressButton(USER, 'm:new');
    const beforePair = resets();
    await bot.pressButton(USER, 'f:usdt:trx');
    expect(resets()).toBe(beforePair);
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');
    expect(resets()).toBe(beforePair + 1);
    expect(bot.lastText()).toContain('Введите сумму');

    await bot.sendText(USER, '/btc');
    expect(bot.lastText()).toContain('Не понял');
    expect(bot.lastText()).not.toContain('Какую монету хотите получить');
  });
});

describe('бот: тестовый режим', () => {
  it('кнопка «следующий статус» двигает обмен через ExchangeService', async () => {
    const confirm = await reachConfirmation();
    await bot.pressButton(USER, confirm);
    const exchangeId = confirm.slice(2);
    expect(bot.lastButtons()).toContain(`d:${exchangeId}`);

    await bot.pressButton(USER, `d:${exchangeId}`);

    expect(bot.exchangeRepository.rows.get(exchangeId)?.status).toBe('CONFIRMING');
    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).not.toContain('Успешно');
  });

  it('проходит весь путь до завершения', async () => {
    const confirm = await reachConfirmation();
    await bot.pressButton(USER, confirm);
    const exchangeId = confirm.slice(2);

    for (let i = 0; i < 4; i += 1) {
      await bot.pressButton(USER, `d:${exchangeId}`);
    }

    expect(bot.exchangeRepository.rows.get(exchangeId)?.status).toBe('FINISHED');
    expect(bot.lastText()).toContain('Получено');
    expect(bot.lastText()).toContain('Успешно');
    expect(bot.lastText()).not.toContain('В ожидании');
    expect(bot.lastButtons()).not.toContain(`d:${exchangeId}`);
  });
});
