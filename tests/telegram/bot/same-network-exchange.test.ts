/**
 * Диалог бота: та же монета и та же сеть идут обычным обменом.
 * Ввод — сумма отправки, депозит ей равен.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_MOCK_CURRENCIES,
  DEFAULT_MOCK_RATES,
  MockExchangeProvider,
} from '../../../src/integrations/mock/mock-exchange-provider.js';
import { BotHarness } from './harness.js';

const USER = 1001;
const ADDRESS = 'mock-payout-address-1';

describe('бот: одинаковая монета и сеть', () => {
  let bot: BotHarness;

  beforeEach(async () => {
    bot = await BotHarness.create();
  });

  it('оставляет ту же монету кнопкой и проводит обмен до оплаты введённой суммой', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    expect(bot.lastButtons()).toContain('t:usdt:trx');

    await bot.pressButton(USER, 't:usdt:trx');
    expect(bot.lastText()).toContain('Введите сумму, которую хотите отдать');
    expect(bot.lastText()).not.toContain('Что вы указываете');
    expect(bot.lastButtons()).not.toContain('b:r');
    expect(bot.lastButtons()).not.toContain('b:s');
    expect(bot.lastText()).not.toContain('Выберите тип курса');

    await bot.sendText(USER, '1000');
    expect(bot.lastText()).toContain('979 USDT (trx)');
    expect(bot.lastText()).not.toContain('1000.002');

    await bot.sendText(USER, ADDRESS);
    expect(bot.lastText()).toContain('Ждёт вашего подтверждения');
    expect(bot.lastText()).toContain('Обмен USDT → USDT');
    expect(bot.lastText()).toContain('Отдаёте: <b>1000 USDT (trx)</b>');
    expect(bot.lastText()).toContain('Получите: <b>979 USDT (trx)</b>');
    expect(bot.lastText()).toContain('Курс: фиксированный');
    expect(bot.lastText()).not.toContain('Без конвертации');
    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.expectedFromAmount).toBe('1000');
    expect(exchange?.expectedToAmount).toBe('979');
    expect(exchange?.rateType).toBe('FIXED');
    expect(exchange?.toNetwork).toBe('trx');

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('Квитанция');
    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).toContain('Адрес получателя');
    expect(bot.lastText()).toContain(ADDRESS);
    expect(bot.lastText()).toContain('Отправьте ровно <b>1000 USDT (trx)</b>');
    expect(bot.lastText()).toContain('обмен продвинется дальше');
    expect(bot.lastText()).toContain('mock-payin-address-');
    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');
    expect(created?.expectedFromAmount).toBe('1000');
    expect(created?.expectedToAmount).toBe('979');

    await bot.pressButton(USER, `d:${confirm.slice(2)}`);
    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).not.toContain('Успешно');
  });

  it('другая монета сразу переходит к сумме и не спрашивает тип курса', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');

    expect(bot.lastText()).toContain('Введите сумму');
    expect(bot.lastButtons()).not.toContain('r:F');
    expect(bot.lastText()).not.toContain('Что вы указываете');
  });

  it('чужая кнопка курса на шаге суммы сбрасывает диалог и не создаёт черновик', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');

    await bot.pressButton(USER, 'r:F');
    expect(bot.lastText()).toContain('устарела');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('слишком маленькая сумма не создаёт черновик', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');

    await bot.sendText(USER, '0.00001');

    expect(bot.lastText()).toContain('меньше минимума');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('та же монета в другой сети тоже спрашивает сумму отправки', async () => {
    const catalog = await BotHarness.create({
      provider: new MockExchangeProvider({
        currencies: [
          ...DEFAULT_MOCK_CURRENCIES,
          {
            ticker: 'usdt',
            network: 'eth',
            name: 'Tether (ERC20)',
            extraId: 'none',
            supportsFixedRate: true,
            featured: false,
          },
        ],
        rates: { ...DEFAULT_MOCK_RATES, 'usdt:trx>usdt:eth': '0.99' },
      }),
    });

    await catalog.pressButton(USER, 'm:new');
    await catalog.pressButton(USER, 'f:usdt:trx');
    await catalog.pressButton(USER, 'u:h');
    expect(catalog.lastButtons()).toContain('t:usdt');

    await catalog.pressButton(USER, 't:usdt');
    expect(catalog.lastButtons()).toContain('t:usdt:eth');
    expect(catalog.lastButtons()).toContain('t:usdt:trx');

    await catalog.pressButton(USER, 't:usdt:eth');

    expect(catalog.lastText()).toContain('Введите сумму');
    expect(catalog.lastButtons()).not.toContain('r:F');
    expect(catalog.lastText()).not.toContain('Что вы указываете');
    expect(catalog.exchangeRepository.rows.size).toBe(0);
  });

  it('обязательный memo просит tag и не даёт пропустить', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:xrp:xrp');
    await bot.pressButton(USER, 't:xrp:xrp');
    await bot.sendText(USER, '10');
    await bot.sendText(USER, ADDRESS);

    expect(bot.lastText()).toContain('нужен Memo/Tag');
    expect(bot.lastButtons()).not.toContain('s:skip');
    expect(bot.exchangeRepository.rows.size).toBe(0);

    await bot.sendText(USER, '12345');

    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.payoutExtraId).toBe('12345');
    expect(exchange?.expectedFromAmount).toBe('10');
    expect(exchange?.toCurrency).toBe('xrp');
    expect(exchange?.toNetwork).toBe('xrp');
  });

  it('необязательный memo можно пропустить, memo депозита от этого не становится выплатой', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.sendText(USER, '/xlm');
    await bot.sendText(USER, '/xlm');
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
    expect(exchange?.expectedFromAmount).toBe('10');
    expect(exchange?.toCurrency).toBe('xlm');

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');
    expect(created?.payoutExtraId).toBeNull();
    expect(created?.payinExtraId).toMatch(/^mock-payin-memo-/);
    expect(bot.lastText()).toContain('Memo/Tag (обязательно)');
    expect(bot.lastText()).toContain('Отправьте ровно <b>10 XLM</b>');
  });
});
