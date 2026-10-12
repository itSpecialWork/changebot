import { describe, expect, it, vi } from 'vitest';
import { callbackData, parseCallbackData } from '../../../src/telegram/bot/callback-data.js';
import type { BotContext } from '../../../src/telegram/bot/context.js';
import type { ExchangeRecord } from '../../../src/domain/exchanges/exchange.js';
import { describeErrorForLog } from '../../../src/telegram/bot/create-bot.js';
import {
  escapeHtml,
  formatCurrency,
  renderExchangeCard,
} from '../../../src/telegram/bot/format.js';
import { exchangeCardKeyboard } from '../../../src/telegram/bot/keyboards.js';
import {
  parseAddressInput,
  parseAmountInput,
  parseExtraIdInput,
} from '../../../src/telegram/bot/input.js';
import { createRateLimiter } from '../../../src/telegram/bot/rate-limit.js';
import { GrammyError } from 'grammy';

const UUID = '0198a2c4-7b1e-7c3a-9d2f-3b5a6c7d8e9f';

describe('callback data', () => {
  it('разбирает собственные кнопки и укладывается в 64 байта', () => {
    expect(parseCallbackData(callbackData.from('usdt', 'trx'))).toEqual({
      kind: 'from',
      ticker: 'usdt',
      network: 'trx',
    });
    expect(parseCallbackData(callbackData.to('btc', 'btc'))).toEqual({
      kind: 'to',
      ticker: 'btc',
      network: 'btc',
    });
    expect(parseCallbackData(callbackData.ticker('from', 'usdt'))).toEqual({
      kind: 'ticker',
      side: 'from',
      ticker: 'usdt',
    });
    expect(parseCallbackData(callbackData.currencyBack)).toEqual({ kind: 'currency_back' });
    expect(parseCallbackData(callbackData.rate('FIXED'))).toEqual({
      kind: 'rate',
      rateType: 'FIXED',
    });
    expect(parseCallbackData(callbackData.transferReceive)).toEqual({
      kind: 'transfer_basis',
      basis: 'receive',
    });
    expect(parseCallbackData(callbackData.transferSpend)).toEqual({
      kind: 'transfer_basis',
      basis: 'spend',
    });
    expect(parseCallbackData(callbackData.receipt(UUID))).toEqual({
      kind: 'receipt',
      exchangeId: UUID,
      full: true,
    });
    expect(parseCallbackData(callbackData.receiptBrief(UUID))).toEqual({
      kind: 'receipt',
      exchangeId: UUID,
      full: false,
    });
    expect(parseCallbackData(callbackData.currencyNext)).toEqual({
      kind: 'currency_page',
      direction: 'next',
    });
    expect(parseCallbackData(callbackData.currencyPrev)).toEqual({
      kind: 'currency_page',
      direction: 'prev',
    });
    expect(parseCallbackData(callbackData.currencyPopular)).toEqual({
      kind: 'currency_catalog',
      catalog: 'popular',
    });
    expect(parseCallbackData(callbackData.currencyAll)).toEqual({
      kind: 'currency_catalog',
      catalog: 'all',
    });
    for (const build of [
      callbackData.open,
      callbackData.confirm,
      callbackData.cancel,
      callbackData.demo,
      callbackData.prepare,
      callbackData.receipt,
      callbackData.receiptBrief,
    ]) {
      const data = build(UUID);
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
      expect(parseCallbackData(data)).toMatchObject({ exchangeId: UUID });
    }
  });

  it.each([
    '',
    'x',
    'c:not-a-uuid',
    `c:${UUID}:extra`,
    'f:USDT:TRX',
    'f:USDT',
    'u:z',
    '__proto__',
    'constructor',
    `z:${UUID}`,
  ])('отклоняет чужие данные %j', (data) => {
    expect(parseCallbackData(data)).toBeUndefined();
  });
});

describe('подпись валюты', () => {
  it('показывает сеть BNB вместо кода bsc и не повторяет сеть у нативной монеты', () => {
    expect(formatCurrency('usdt', 'trx')).toBe('USDT (trx)');
    expect(formatCurrency('usdt', 'bsc')).toBe('USDT (bnb)');
    expect(formatCurrency('btc', 'btc')).toBe('BTC');
    expect(formatCurrency('bnb', 'bsc')).toBe('BNB');
  });
});

describe('разбор ввода', () => {
  it('сумма: числа с точкой и запятой', () => {
    expect(parseAmountInput(' 100 ')).toBe('100');
    expect(parseAmountInput('0,5')).toBe('0.5');
    expect(parseAmountInput('0.00012')).toBe('0.00012');
  });

  it.each(['', 'abc', '-1', '1e5', '1.2.3', '.5', '1 000', '0x10'])(
    'сумма: отклоняет %j',
    (text) => {
      expect(parseAmountInput(text)).toBeUndefined();
    },
  );

  it('адрес: принимает типичные форматы и отклоняет мусор', () => {
    expect(parseAddressInput('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBeDefined();
    expect(parseAddressInput('TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE')).toBeDefined();
    expect(parseAddressInput('0x71C7656EC7ab88b098defB751B7401B5f6d8976F')).toBeDefined();
    expect(parseAddressInput('short')).toBeUndefined();
    expect(parseAddressInput('has space inside address')).toBeUndefined();
    expect(parseAddressInput('<b>bold</b>address')).toBeUndefined();
    expect(parseAddressInput('a'.repeat(200))).toBeUndefined();
  });

  it('memo: ограничивает длину и символы', () => {
    expect(parseExtraIdInput('12345')).toBe('12345');
    expect(parseExtraIdInput('')).toBeUndefined();
    expect(parseExtraIdInput('a'.repeat(65))).toBeUndefined();
    expect(parseExtraIdInput('<x>')).toBeUndefined();
  });
});

describe('format', () => {
  it('экранирует HTML', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href="x"&gt;&amp;&lt;/a&gt;');
  });

  it('карточка экранирует внешние значения', () => {
    const exchange = {
      id: UUID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      expectedFromAmount: '100',
      expectedToAmount: '0.0016',
      actualToAmount: null,
      rateType: 'FLOATING',
      quoteExpiresAt: null,
      status: 'WAITING_DEPOSIT',
      payinAddress: '<img src=x>',
      payinExtraId: null,
      payoutAddress: 'addr',
      payoutExtraId: null,
      payinHash: null,
      payoutHash: null,
      refundHash: null,
    } as unknown as ExchangeRecord;

    const card = renderExchangeCard(exchange, { demo: false });

    expect(card).toContain('&lt;img src=x&gt;');
    expect(card).not.toContain('<img');
    expect(card).toContain('<blockquote><b>Квитанция</b>');
    expect(card).toContain('Адрес получателя');
    expect(card).toContain('<code>addr</code>');
    expect(card).toContain('Сумма: <b>100 USDT (trx)</b>');
    expect(card).toContain('Статус: <i>В ожидании</i>');
    expect(card).toContain(`ID: <code>${UUID}</code>`);
    expect(card).toContain('Обмен USDT → BTC');
    expect(card).toContain('Курс: плавающий');
    expect(card).not.toContain('Тестовый режим');
    expect(card).not.toContain('<b>Успешно</b>');
    expect(card).not.toContain('Хэш');
  });

  it('после зачисления та же квитанция меняет статус на успешный', () => {
    const exchange = {
      id: UUID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'btc',
      toNetwork: 'btc',
      expectedFromAmount: '100',
      expectedToAmount: '0.0016',
      actualFromAmount: '100',
      actualToAmount: '0.00155',
      rateType: 'FLOATING',
      quoteExpiresAt: null,
      status: 'FINISHED',
      payinAddress: 'payin',
      payinExtraId: null,
      payoutAddress: 'bc1q-payout',
      payoutExtraId: 'tag&1',
      payinHash: '00deposit',
      payoutHash: 'payout<hash>&1',
      refundHash: null,
      statusChangedAt: new Date('2026-10-12T14:19:00.000Z'),
    } as unknown as ExchangeRecord;

    const card = renderExchangeCard(exchange, { demo: false });

    expect(card).toContain('<blockquote><b>Квитанция</b>');
    expect(card).toContain('Статус: <b>Успешно</b>');
    expect(card).not.toContain('В ожидании');
    expect(card).toContain('Сумма: <b>100 USDT (trx)</b>');
    expect(card).toContain('Получено: <b>0.00155 BTC</b>');
    expect(card).toContain('<code>bc1q-payout</code>');
    expect(card).toContain('Memo/Tag: <code>tag&amp;1</code>');
    expect(card).toContain(`ID: <code>${UUID}</code>`);
    expect(card).toContain('Время отправки: 12.10, 14:19 UTC');
    expect(card).not.toContain('Курс:');
    expect(card).not.toContain('Хэш');
    expect(card).not.toContain('00deposit');
    expect(card).not.toContain('payout&lt;');
    expect(card).not.toContain('payin');
    expect(card).not.toContain('Отправьте ровно');

    const full = renderExchangeCard(exchange, { demo: false, fullReceipt: true });
    expect(full).toContain('<blockquote expandable>Хэш выплаты');
    expect(full).toContain('<code>payout&lt;hash&gt;&amp;1</code>');
    expect(full).not.toContain('payout<hash>');
    expect(full).not.toContain('Хэш депозита');
    expect(full).not.toContain('00deposit');
    expect(full).not.toContain('Хэш возврата');

    const buttonText = (fullReceipt: boolean): string[] =>
      exchangeCardKeyboard(exchange, { demo: false, fullReceipt })
        .inline_keyboard.flat()
        .flatMap((button) => ('text' in button ? [button.text] : []));
    expect(buttonText(false)).toContain('Полная квитанция оплаты');
    expect(buttonText(true)).toContain('Свернуть квитанцию');

    const refunded = renderExchangeCard(
      { ...exchange, refundHash: 'refund&hash' },
      { demo: false, fullReceipt: true },
    );
    expect(refunded).toContain('<blockquote expandable>Хэш возврата');
    expect(refunded).toContain('<code>refund&amp;hash</code>');
    expect(refunded).not.toContain('Хэш депозита');
  });

  it('ту же монету и сеть называет переводом без курса', () => {
    const exchange = {
      id: UUID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'usdt',
      toNetwork: 'trx',
      expectedFromAmount: '101',
      expectedToAmount: '100',
      actualToAmount: null,
      rateType: 'FIXED',
      quoteExpiresAt: new Date('2026-10-12T12:00:00Z'),
      status: 'AWAITING_CONFIRMATION',
      payinAddress: null,
      payinExtraId: null,
      payoutAddress: 'addr',
      payoutExtraId: null,
    } as unknown as ExchangeRecord;

    const card = renderExchangeCard(exchange, { demo: false });

    expect(card).toContain('<b>Перевод USDT (trx)</b>');
    expect(card).toContain('Без конвертации. Суммы действуют до 12.10, 12:00 UTC.');
    expect(card).not.toContain('Обмен');
    expect(card).not.toContain('Курс:');
  });

  it('ту же монету в другой сети оставляет обменом с типом курса', () => {
    const exchange = {
      id: UUID,
      fromCurrency: 'usdt',
      fromNetwork: 'trx',
      toCurrency: 'usdt',
      toNetwork: 'eth',
      expectedFromAmount: '100',
      expectedToAmount: '99',
      actualToAmount: null,
      rateType: 'FIXED',
      quoteExpiresAt: null,
      status: 'AWAITING_CONFIRMATION',
      payinAddress: null,
      payinExtraId: null,
      payoutAddress: 'addr',
      payoutExtraId: null,
    } as unknown as ExchangeRecord;

    const card = renderExchangeCard(exchange, { demo: false });

    expect(card).toContain('<b>Обмен USDT → USDT</b>');
    expect(card).toContain('Курс: фиксированный');
    expect(card).not.toContain('Перевод');
    expect(card).not.toContain('Без конвертации');
  });
});

describe('describeErrorForLog', () => {
  it('для ошибок Telegram не включает payload запроса', () => {
    const error = new GrammyError(
      'failed',
      { ok: false, error_code: 400, description: 'Bad Request', parameters: {} },
      'sendMessage',
      { text: 'bc1qsecretaddress' },
    );

    const described = JSON.stringify(describeErrorForLog(error));

    expect(described).toContain('400');
    expect(described).not.toContain('bc1qsecretaddress');
  });
});

describe('rate limiter', () => {
  function context(
    userId: number,
    callback = false,
    answer = vi.fn().mockResolvedValue(true),
  ): BotContext {
    return {
      from: { id: userId },
      callbackQuery: callback ? { id: 'x' } : undefined,
      answerCallbackQuery: answer,
    } as unknown as BotContext;
  }

  it('пропускает лимит обновлений за окно и отбрасывает лишние', async () => {
    let time = 0;
    const limiter = createRateLimiter({ limit: 2, windowMs: 1000, now: () => time });
    const next = vi.fn().mockResolvedValue(undefined);

    for (let i = 0; i < 4; i += 1) await limiter(context(1), next);
    expect(next).toHaveBeenCalledTimes(2);

    time = 1000;
    await limiter(context(1), next);
    expect(next).toHaveBeenCalledTimes(3);
  });

  it('лимит у каждого пользователя свой, на кнопки отвечает предупреждением', async () => {
    const limiter = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    const next = vi.fn().mockResolvedValue(undefined);

    await limiter(context(1), next);
    const answer = vi.fn().mockResolvedValue(true);
    await limiter(context(1, true, answer), next);
    await limiter(context(2), next);

    expect(next).toHaveBeenCalledTimes(2);
    expect(answer).toHaveBeenCalledOnce();
  });
});
