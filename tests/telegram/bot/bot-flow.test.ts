import { beforeEach, describe, expect, it } from 'vitest';
import { BotHarness } from './harness.js';

const USER = 1001;
const OTHER_USER = 2002;
const ADDRESS = 'mock-payout-address-1';

let bot: BotHarness;

beforeEach(async () => {
  bot = await BotHarness.create();
});

/** Проходит диалог до карточки подтверждения (USDT trx → BTC, плавающий курс, 100). */
async function reachConfirmation(userId = USER): Promise<string> {
  await bot.pressButton(userId, 'm:new');
  await bot.pressButton(userId, 'f:usdt:trx');
  await bot.pressButton(userId, 'u:a');
  await bot.pressButton(userId, 't:btc:btc');
  await bot.pressButton(userId, 'r:F');
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
    expect(bot.lastButtons()).toEqual(expect.arrayContaining(['m:new', 'm:list', 'm:help']));
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
});

describe('бот: создание обмена', () => {
  it('ведёт от выбора валют до карточки подтверждения', async () => {
    const confirm = await reachConfirmation();

    const text = bot.lastText();
    expect(text).toContain('Ждёт вашего подтверждения');
    expect(text).toContain('100 USDT (trx)');
    expect(text).toContain('0.0016 BTC');
    expect(text).toContain(ADDRESS);
    expect(confirm).toMatch(/^c:[0-9a-f-]{36}$/);
    expect(bot.exchangeRepository.rows.size).toBe(1);
  });

  it('подтверждение создаёт обмен и показывает инструкцию по оплате', async () => {
    const confirm = await reachConfirmation();

    await bot.pressButton(USER, confirm);

    const text = bot.lastText();
    expect(text).toContain('Ожидаем ваш платёж');
    expect(text).toContain('mock-payin-address-1');
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

  it('фиксированный курс доступен только для поддерживаемых пар', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:xrp:xrp');
    expect(bot.lastButtons()).toContain('r:F');
    expect(bot.lastButtons()).not.toContain('r:X');

    // Принудительно присланная кнопка фиксированного курса отклоняется.
    await bot.pressButton(USER, 'r:X');
    expect(bot.lastText()).toContain('устарела');
  });

  it('для валюты с необязательным memo ставит «Пропустить» рядом с отменой', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.sendText(USER, 'xlm');
    await bot.pressButton(USER, 't:xlm:xlm');
    await bot.pressButton(USER, 'r:F');
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
    await bot.pressButton(USER, 'r:F');
    await bot.sendText(USER, '10');
    await bot.sendText(USER, ADDRESS);
    expect(bot.lastText()).toContain('нужен Memo/Tag');
    expect(bot.lastButtons()).not.toContain('s:skip');

    await bot.sendText(USER, '12345');

    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.payoutExtraId).toBe('12345');
    expect(bot.lastText()).toContain('Memo/Tag: <code>12345</code>');
  });

  it('просит ввести сумму заново при мусоре и выходе за лимиты', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');
    await bot.pressButton(USER, 'r:F');
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
    await bot.pressButton(USER, 'r:F');
    await bot.sendText(USER, '100');

    await bot.sendText(USER, '<script>alert(1)</script>');

    expect(bot.lastText()).toContain('некорректно');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('неподдерживаемая пара сообщается на шаге суммы, черновик не создаётся', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 'f:btc:btc');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:xrp:xrp');
    await bot.pressButton(USER, 'r:F');

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
});

describe('бот: мои обмены', () => {
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
    expect(bot.lastButtons()).toContain('f:btc:btc');
    expect(bot.lastButtons()).not.toContain('f:eth:eth');
  });

  it('команда /btc выбирает монету так же, как кнопка', async () => {
    await bot.pressButton(USER, 'm:new');

    const menu = bot.calls.find((call) => call.method === 'setMyCommands');
    const commands = menu?.payload.commands as { command: string }[] | undefined;
    expect(commands?.map((command) => command.command)).toContain('btc');
    expect(commands?.map((command) => command.command)).toContain('xlm');

    await bot.sendText(USER, '/btc');

    expect(bot.lastText()).toContain('Что хотите получить');
    expect(bot.lastButtons()).toContain('t:eth:eth');
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
    expect(bot.lastText()).toContain('Ждём подтверждения сети');
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
    expect(bot.lastButtons()).not.toContain(`d:${exchangeId}`);
  });
});
