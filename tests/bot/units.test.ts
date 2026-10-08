import { describe, expect, it, vi } from 'vitest';
import { callbackData, parseCallbackData } from '../../src/bot/callback-data.js';
import type { BotContext } from '../../src/bot/context.js';
import type { ExchangeRecord } from '../../src/domain/exchanges/exchange.js';
import { describeErrorForLog } from '../../src/bot/create-bot.js';
import { escapeHtml, renderExchangeCard } from '../../src/bot/format.js';
import { parseAddressInput, parseAmountInput, parseExtraIdInput } from '../../src/bot/input.js';
import { createRateLimiter } from '../../src/bot/rate-limit.js';
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
    expect(parseCallbackData(callbackData.rate('FIXED'))).toEqual({
      kind: 'rate',
      rateType: 'FIXED',
    });
    for (const build of [
      callbackData.open,
      callbackData.confirm,
      callbackData.cancel,
      callbackData.demo,
      callbackData.prepare,
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
    'f:usdt',
    '__proto__',
    'constructor',
    `z:${UUID}`,
  ])('отклоняет чужие данные %j', (data) => {
    expect(parseCallbackData(data)).toBeUndefined();
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
    } as unknown as ExchangeRecord;

    const card = renderExchangeCard(exchange, { demo: false });

    expect(card).toContain('&lt;img src=x&gt;');
    expect(card).not.toContain('<img');
    expect(card).not.toContain('Тестовый режим');
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
