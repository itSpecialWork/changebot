/**
 * Диалог бота: выбранная монета остаётся во втором списке только при включённом переводе.
 */
import { beforeEach, describe, expect, it } from 'vitest';
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

    expect(bot.lastButtons()).not.toContain('t:usdt:trx');

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
    const exchange = [...bot.exchangeRepository.rows.values()][0];
    expect(exchange?.expectedToAmount).toBe('100');
    expect(exchange?.expectedFromAmount).toBe('101');
    expect(exchange?.rateType).toBe('FIXED');
    expect(exchange?.toNetwork).toBe('trx');

    const confirm = bot.lastButtons().find((data) => data.startsWith('c:'));
    if (!confirm) throw new Error('Confirm button is missing');
    await bot.pressButton(USER, confirm);

    expect(bot.lastText()).toContain('Ожидаем ваш платёж');
    expect(bot.lastText()).toContain('mock-payin-address-');
    const created = bot.exchangeRepository.rows.get(confirm.slice(2));
    expect(created?.status).toBe('WAITING_DEPOSIT');

    await bot.pressButton(USER, `d:${confirm.slice(2)}`);
    expect(bot.lastText()).toContain('Ждём подтверждения сети');
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
  });

  it('другая монета по-прежнему спрашивает тип курса', async () => {
    await bot.pressButton(USER, 'm:new');
    await bot.pressButton(USER, 'f:usdt:trx');
    await bot.pressButton(USER, 'u:a');
    await bot.pressButton(USER, 't:btc:btc');

    expect(bot.lastText()).toContain('Выберите тип курса');
    expect(bot.lastButtons()).toContain('r:F');
  });
});
