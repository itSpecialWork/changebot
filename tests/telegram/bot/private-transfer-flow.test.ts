/**
 * Диалог бота: выбранная монета остаётся во втором списке только при включённом переводе.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { compareDecimal } from '../../../src/domain/shared/decimal-string.js';
import {
  DEFAULT_MOCK_CURRENCIES,
  DEFAULT_MOCK_RATES,
  MockExchangeProvider,
} from '../../../src/integrations/mock/mock-exchange-provider.js';
import { MockPrivateTransferProvider } from '../../../src/integrations/mock/mock-private-transfer-provider.js';
import { BotHarness } from './harness.js';

const USER = 1001;
const ADDRESS = 'mock-payout-address-1';

describe('бот: перевод той же монеты выключен', () => {
  let bot: BotHarness;

  beforeEach(async () => {
    bot = await BotHarness.create();
  });

  it('не показывает выбранную монету во втором списке и не принимает её кнопку', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');

    expect(bot.lastButtons()).not.toContain('t:usdt');

    await bot.pressButton(USER, 't:usdt:trx');
    expect(bot.lastText()).toContain('устарела');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });
});

describe('бот: перевод той же монеты включён', () => {
  let bot: BotHarness;

  beforeEach(async () => {
    bot = await BotHarness.create({ privateTransfer: new MockPrivateTransferProvider() });
  });

  it('оставляет ту же монету кнопкой и проводит перевод до оплаты', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    expect(bot.lastButtons()).toContain('t:usdt');
    expect(bot.lastButtons()).not.toContain('t:usdt:trx');

    await bot.pressButton(USER, 't:usdt');
    expect(bot.lastButtons()).toContain('t:usdt:trx');

    await bot.pressButton(USER, 't:usdt:trx');
    expect(bot.lastText()).toContain('Что вы указываете');
    expect(bot.lastButtons()).toContain('b:r');
    expect(bot.lastButtons()).toContain('b:s');
    expect(bot.lastText()).not.toContain('Выберите тип курса');

    await bot.pressButton(USER, 'b:r');
    expect(bot.lastText()).toContain('должен получить адресат');

    await bot.sendText(USER, '100');
    expect(bot.lastText()).toContain('100 USDT (trx)');
    expect(bot.lastText()).toContain('101 USDT (trx)');

    await bot.sendText(USER, ADDRESS);
    expect(bot.lastText()).toContain('Ждёт вашего подтверждения');
    expect(bot.lastText()).toContain('Перевод USDT (trx)');
    expect(bot.lastText()).toContain('Без конвертации');
    expect(bot.lastText()).not.toContain('Курс: фиксированный');
    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.expectedToAmount).toBe('100');
    expect(exchange?.expectedFromAmount).toBe('101');
    expect(exchange?.rateType).toBe('FIXED');
    expect(exchange?.toNetwork).toBe('trx');

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('Квитанция');
    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).toContain('Адрес получателя');
    expect(bot.lastText()).toContain(ADDRESS);
    expect(bot.lastText()).toContain('перевод продвинется дальше');
    expect(bot.lastText()).toContain('mock-payin-address-');
    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');

    await bot.pressButton(USER, `d:${confirm.slice(2)}`);
    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).not.toContain('Успешно');
  });

  it('от суммы отправителя считает, сколько получит адресат, и не просит отправить больше', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');
    await bot.pressButton(USER, 'b:s');
    expect(bot.lastText()).toContain('которая у вас есть');

    await bot.sendText(USER, '101');
    expect(bot.lastText()).toContain('100 USDT (trx)');
    expect(bot.lastText()).toContain('101 USDT (trx)');

    await bot.sendText(USER, ADDRESS);
    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.expectedToAmount).toBe('100');
    expect(exchange?.expectedFromAmount).toBe('101');
    expect(bot.lastText()).toContain('Ждёт вашего подтверждения');

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('В ожидании');
    expect(bot.lastText()).toContain('Сумма: <b>101 USDT (trx)</b>');
    expect(bot.lastText()).toContain('Отправьте ровно <b>101 USDT (trx)</b>');
    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');
    expect(created?.expectedFromAmount).toBe('101');
    expect(compareDecimal(created?.expectedFromAmount ?? '0', '101')).toBeLessThanOrEqual(0);

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

  it('на шаге выбора суммы текст просит кнопку и не создаёт черновик', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');

    await bot.sendText(USER, '100');

    expect(bot.lastText()).toContain('кнопкой ниже');
    expect(bot.lastButtons()).toContain('b:r');
    expect(bot.lastButtons()).toContain('b:s');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('чужая кнопка и кнопка после ухода с шага сбрасывают диалог', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');

    await bot.pressButton(USER, 'r:F');
    expect(bot.lastText()).toContain('устарела');
    expect(bot.exchangeRepository.rows.size).toBe(0);

    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');
    await bot.pressButton(USER, 'b:r');
    expect(bot.lastText()).toContain('должен получить адресат');

    await bot.pressButton(USER, 'b:s');
    expect(bot.lastText()).toContain('устарела');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('слишком маленькая сумма перевода не создаёт черновик', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 't:usdt:trx');
    await bot.pressButton(USER, 'b:r');

    await bot.sendText(USER, '0.00001');

    expect(bot.lastText()).toContain('вне допустимого диапазона');
    expect(bot.exchangeRepository.rows.size).toBe(0);
  });

  it('та же монета в другой сети показывает тип курса и не вызывает перевод', async () => {
    const transfer = new MockPrivateTransferProvider();
    const estimate = vi.spyOn(transfer, 'estimate');
    const create = vi.spyOn(transfer, 'create');
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
      privateTransfer: transfer,
    });

    await catalog.pressButton(USER, 'm:new');
    await catalog.pressButton(USER, 'f:usdt:trx');
    expect(catalog.lastButtons()).toContain('t:usdt');

    await catalog.pressButton(USER, 't:usdt');
    expect(catalog.lastButtons()).toContain('t:usdt:eth');
    expect(catalog.lastButtons()).toContain('t:usdt:trx');

    await catalog.pressButton(USER, 't:usdt:eth');

    expect(catalog.lastText()).toContain('Введите сумму');
    expect(catalog.lastButtons()).not.toContain('r:F');
    expect(catalog.lastText()).not.toContain('Что вы указываете');
    expect(estimate).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(catalog.exchangeRepository.rows.size).toBe(0);
  });

  it('обязательный memo перевода просит tag и не даёт пропустить', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:xrp:xrp');
    await bot.pressButton(USER, 't:xrp:xrp');
    await bot.pressButton(USER, 'b:r');
    await bot.sendText(USER, '10');
    await bot.sendText(USER, ADDRESS);

    expect(bot.lastText()).toContain('нужен Memo/Tag');
    expect(bot.lastButtons()).not.toContain('s:skip');
    expect(bot.exchangeRepository.rows.size).toBe(0);

    await bot.sendText(USER, '12345');

    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.payoutExtraId).toBe('12345');
    expect(exchange?.toCurrency).toBe('xrp');
    expect(exchange?.toNetwork).toBe('xrp');
  });

  it('необязательный memo перевода можно пропустить, memo депозита от этого не становится выплатой', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.sendText(USER, '/xlm');
    await bot.sendText(USER, '/xlm');
    await bot.pressButton(USER, 'b:r');
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

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');
    expect(created?.payoutExtraId).toBeNull();
    expect(created?.payinExtraId).toMatch(/^mock-payin-memo-/);
    expect(bot.lastText()).toContain('Memo/Tag (обязательно)');
  });
});
