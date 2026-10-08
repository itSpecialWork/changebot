import { describe, expect, it } from 'vitest';
import type { ProviderCurrency } from '../../../src/domain/exchanges/exchange-provider.js';
import {
  CURRENCY_PAGE_SIZE,
  currencyKeyboard,
  selectCurrencies,
} from '../../../src/telegram/bot/keyboards.js';

function currency(
  ticker: string,
  name: string,
  featured = false,
  network = 'eth',
): ProviderCurrency {
  return { ticker, network, name, extraId: 'none', supportsFixedRate: false, featured };
}

function callbacks(
  kind: 'from' | 'to',
  currencies: readonly ProviderCurrency[],
  query = '',
  page = 0,
): string[] {
  const selection = selectCurrencies(currencies, { query, page });
  return currencyKeyboard(kind, selection)
    .inline_keyboard.flat()
    .flatMap((button) =>
      'callback_data' in button && button.callback_data ? [button.callback_data] : [],
    );
}

describe('клавиатура валют', () => {
  it('короткий список показывает все безопасные валюты', () => {
    const buttons = callbacks('from', [
      currency('btc', 'Bitcoin', true, 'btc'),
      currency('usdt', 'Tether', true, 'trx'),
      currency('bad ticker', 'Unsafe', true),
    ]);

    expect(buttons).toEqual(['f:btc:btc', 'f:usdt:trx', 'm:menu']);
  });

  it('длинный каталог без запроса показывает только featured', () => {
    const many = Array.from({ length: CURRENCY_PAGE_SIZE + 1 }, (_, index) =>
      currency(`c${String(index)}`, `Coin ${String(index)}`),
    );
    const currencies = [
      ...many,
      currency('btc', 'Bitcoin', true, 'btc'),
      currency('bad ticker', 'Unsafe', true),
    ];

    const buttons = callbacks('from', currencies);

    expect(buttons).toEqual(['f:btc:btc', 'm:menu']);
    expect(selectCurrencies(currencies, { query: '', page: 0 }).mode).toBe('featured');
  });

  it('поиск usdt даёт кнопки с сетью и листается, если совпадений больше страницы', () => {
    const matches = Array.from({ length: CURRENCY_PAGE_SIZE + 1 }, (_, index) =>
      currency('usdt', `Tether ${String(index)}`, false, `n${String(index)}`),
    );

    const first = callbacks('to', matches, 'usdt', 0);
    expect(first).toContain('t:usdt:n0');
    expect(first).toContain('u:n');
    expect(first).not.toContain('u:p');
    expect(first.filter((data) => data.startsWith('t:'))).toHaveLength(CURRENCY_PAGE_SIZE);

    const second = callbacks('to', matches, 'tether', 1);
    expect(second).toContain('u:p');
    expect(second).not.toContain('u:n');
    expect(second.filter((data) => data.startsWith('t:'))).toHaveLength(1);
    for (const data of [...first, ...second]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });
});
