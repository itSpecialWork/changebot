import { describe, expect, it } from 'vitest';
import type { ProviderCurrency } from '../../../src/domain/exchanges/exchange-provider.js';
import {
  CURRENCY_PAGE_SIZE,
  CURRENCY_SUGGESTION_SIZE,
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
  catalog: 'popular' | 'all' = 'popular',
): string[] {
  const selection = selectCurrencies(currencies, { query, page, catalog });
  return currencyKeyboard(kind, selection)
    .inline_keyboard.flat()
    .flatMap((button) =>
      'callback_data' in button && button.callback_data ? [button.callback_data] : [],
    );
}

describe('клавиатура валют', () => {
  it('популярные начинаются с USDT TRC20 и TRX, сеть bsc подписана как BEP20', () => {
    const currencies = [
      currency('btc', 'Bitcoin', true, 'btc'),
      currency('trx', 'TRON', false, 'trx'),
      currency('usdt', 'Tether TRC20', false, 'trx'),
      currency('usdt', 'Tether BEP20', false, 'bsc'),
      currency('usdt', 'Tether BNB', false, 'bnb'),
      currency('bad ticker', 'Unsafe', true),
    ];
    const selection = selectCurrencies(currencies, { query: '', page: 0, catalog: 'popular' });
    const labels = currencyKeyboard('from', selection)
      .inline_keyboard.flat()
      .flatMap((button) => ('text' in button ? [button.text] : []));

    expect(selection.items.map((item) => `${item.ticker}:${item.network}`)).toEqual([
      'usdt:trx',
      'trx:trx',
      'btc:btc',
      'usdt:bsc',
    ]);
    expect(callbacks('from', currencies)).toEqual([
      'f:usdt:trx',
      'f:trx:trx',
      'f:btc:btc',
      'f:usdt:bsc',
      'u:a',
      'm:menu',
    ]);
    expect(labels).toContain('USDT · TRC20');
    expect(labels).toContain('TRX');
    expect(labels).toContain('USDT · BEP20');
    expect(labels).not.toContain('USDT · bsc');
    expect(labels).not.toContain('USDT · bnb');
    expect(selection.mode).toBe('popular');
  });

  it('буква x показывает тикеры с этого начала и ставит популярные выше', () => {
    const currencies = [
      currency('btc', 'Bitcoin', false, 'btc'),
      currency('xlm', 'Stellar', false, 'xlm'),
      currency('xrp', 'XRP', false, 'xrp'),
      currency('box', 'Xbox coin', false, 'box'),
      currency('eth', 'Ethereum', false, 'eth'),
    ];
    const selection = selectCurrencies(currencies, { query: 'x', page: 0, catalog: 'popular' });

    expect(selection.mode).toBe('search');
    expect(selection.items.map((item) => item.ticker)).toEqual(['xrp', 'xlm']);
  });

  it('полный каталог листает все безопасные валюты и возвращает к актуальным', () => {
    const many = Array.from({ length: CURRENCY_PAGE_SIZE + 1 }, (_, index) =>
      currency(`c${String(index)}`, `Coin ${String(index)}`, false, `n${String(index)}`),
    );

    const buttons = callbacks('from', many, '', 0, 'all');

    expect(buttons).toContain('f:c0:n0');
    expect(buttons).toContain('u:n');
    expect(buttons).toContain('u:h');
    expect(buttons).not.toContain('u:a');
    expect(buttons.filter((data) => data.startsWith('f:'))).toHaveLength(CURRENCY_PAGE_SIZE);
    expect(selectCurrencies(many, { query: '', page: 0, catalog: 'all' }).mode).toBe('all');
  });

  it('поиск usdt даёт кнопки с сетью и листается, если совпадений больше страницы', () => {
    const matches = Array.from({ length: CURRENCY_SUGGESTION_SIZE + 1 }, (_, index) =>
      currency('usdt', `Tether ${String(index)}`, false, `n${String(index)}`),
    );

    const first = callbacks('to', matches, 'usdt', 0, 'all');
    expect(first).toContain('t:usdt:n0');
    expect(first).toContain('u:n');
    expect(first).not.toContain('u:p');
    expect(first.filter((data) => data.startsWith('t:'))).toHaveLength(CURRENCY_SUGGESTION_SIZE);

    const second = callbacks('to', matches, 'tether', 1, 'popular');
    expect(second).toContain('u:p');
    expect(second).not.toContain('u:n');
    expect(second.filter((data) => data.startsWith('t:'))).toHaveLength(1);
    for (const data of [...first, ...second]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });
});
