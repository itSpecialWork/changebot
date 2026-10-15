import { describe, expect, it } from 'vitest';
import type { ProviderCurrency } from '../../../src/domain/exchanges/exchange-provider.js';
import {
  CURRENCY_PAGE_SIZE,
  currencyKeyboard,
  mainMenuKeyboard,
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
  catalog: 'base' | 'popular' | 'all' = 'popular',
): string[] {
  const selection = selectCurrencies(currencies, { query, page, catalog });
  return currencyKeyboard(kind, selection)
    .inline_keyboard.flat()
    .flatMap((button) =>
      'callback_data' in button && button.callback_data ? [button.callback_data] : [],
    );
}

describe('клавиатура валют', () => {
  it('базовый экран показывает готовые пары и не спрашивает сеть ещё раз', () => {
    const currencies = [
      currency('btc', 'Bitcoin', true, 'btc'),
      currency('trx', 'TRON', false, 'trx'),
      currency('sol', 'Solana', false, 'sol'),
      currency('eth', 'Ethereum', false, 'eth'),
      currency('usdt', 'Tether TRC20', false, 'trx'),
      currency('usdt', 'Tether BEP20', false, 'bsc'),
      currency('usdt', 'Tether BNB', false, 'bnb'),
    ];
    const selection = selectCurrencies(currencies, { query: '', page: 0, catalog: 'base' });
    const labels = currencyKeyboard('from', selection)
      .inline_keyboard.flat()
      .flatMap((button) => ('text' in button ? [button.text] : []));

    expect(selection.items.map((item) => `${item.ticker}:${item.network}`)).toEqual([
      'usdt:trx',
      'usdt:bsc',
      'btc:btc',
      'trx:trx',
      'sol:sol',
    ]);
    expect(callbacks('from', currencies, '', 0, 'base')).toEqual([
      'f:usdt:trx',
      'f:usdt:bsc',
      'f:btc:btc',
      'f:trx:trx',
      'f:sol:sol',
      'u:h',
      'm:menu',
    ]);
    expect(labels).toEqual([
      'USDT TRX',
      'USDT BNB',
      'BTC',
      'TRX',
      'SOL',
      '📋 Все валюты',
      '❌ Отмена',
    ]);
    expect(selection.mode).toBe('base');
  });

  it('популярные монеты начинаются с USDT, без повтора сетей', () => {
    const currencies = [
      currency('btc', 'Bitcoin', true, 'btc'),
      currency('trx', 'TRON', false, 'trx'),
      currency('usdt', 'Tether TRC20', false, 'trx'),
      currency('usdt', 'Tether BEP20', false, 'bsc'),
      currency('usdt', 'Tether BNB', false, 'bnb'),
      currency('usdt', 'Tether SOL', false, 'sol'),
      currency('bad ticker', 'Unsafe', true),
    ];
    const selection = selectCurrencies(currencies, { query: '', page: 0, catalog: 'popular' });
    const labels = currencyKeyboard('from', selection)
      .inline_keyboard.flat()
      .flatMap((button) => ('text' in button ? [button.text] : []));

    expect(selection.items.map((item) => item.ticker)).toEqual(['usdt', 'trx', 'btc']);
    expect(callbacks('from', currencies)).toEqual(['f:usdt', 'f:trx', 'f:btc', 'u:s', 'm:menu']);
    expect(labels).toEqual(expect.arrayContaining(['USDT', 'TRX', 'BTC']));
    expect(labels).not.toContain('USDT · TRC20');
    expect(selection.mode).toBe('popular');
    expect(selection.stage).toBe('token');
  });

  it('в актуальном списке у USDT только короткие сети, подпись BEP20', () => {
    const currencies = [
      currency('usdt', 'Tether TRC20', false, 'trx'),
      currency('usdt', 'Tether ERC20', false, 'eth'),
      currency('usdt', 'Tether BEP20', false, 'bsc'),
      currency('usdt', 'Tether BNB', false, 'bnb'),
      currency('usdt', 'Tether SOL', false, 'sol'),
    ];
    const selection = selectCurrencies(currencies, {
      query: '',
      page: 0,
      catalog: 'popular',
      stage: 'network',
      ticker: 'usdt',
      networkScope: 'popular',
    });
    const labels = currencyKeyboard('from', selection)
      .inline_keyboard.flat()
      .flatMap((button) => ('text' in button ? [button.text] : []));

    expect(selection.items.map((item) => `${item.ticker}:${item.network}`)).toEqual([
      'usdt:trx',
      'usdt:eth',
      'usdt:bsc',
    ]);
    expect(labels).toEqual(expect.arrayContaining(['TRC20', 'ERC20', 'BEP20', 'Назад']));
    expect(labels).not.toContain('SOL');
    expect(labels).not.toContain('USDT · bsc');
  });

  it('в полном каталоге у монеты все её сети', () => {
    const currencies = [
      currency('usdt', 'Tether TRC20', false, 'trx'),
      currency('usdt', 'Tether SOL', false, 'sol'),
    ];
    const selection = selectCurrencies(currencies, {
      query: '',
      page: 0,
      catalog: 'all',
      stage: 'network',
      ticker: 'usdt',
      networkScope: 'all',
    });

    expect(selection.items.map((item) => item.network)).toEqual(['trx', 'sol']);
    expect(callbacks('from', currencies, '', 0, 'all')).toContain('f:usdt');
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

    expect(buttons).toContain('f:c0');
    expect(buttons).toContain('u:n');
    expect(buttons).toContain('u:h');
    expect(buttons).not.toContain('u:a');
    expect(buttons.filter((data) => data.startsWith('f:'))).toHaveLength(CURRENCY_PAGE_SIZE);
    expect(selectCurrencies(many, { query: '', page: 0, catalog: 'all' }).mode).toBe('all');
  });

  it('поиск usdt даёт одну монету, а её сети листаются отдельно', () => {
    const matches = Array.from({ length: CURRENCY_PAGE_SIZE + 1 }, (_, index) =>
      currency('usdt', `Tether ${String(index)}`, false, `n${String(index)}`),
    );

    const tokens = callbacks('to', matches, 'usdt', 0, 'all');
    expect(tokens).toContain('t:usdt');
    expect(tokens.filter((data) => data.startsWith('t:'))).toHaveLength(1);
    expect(tokens).not.toContain('t:usdt:n0');

    const networks = selectCurrencies(matches, {
      query: '',
      page: 0,
      catalog: 'all',
      stage: 'network',
      ticker: 'usdt',
      networkScope: 'all',
    });
    const first = currencyKeyboard('to', networks)
      .inline_keyboard.flat()
      .flatMap((button) =>
        'callback_data' in button && button.callback_data ? [button.callback_data] : [],
      );
    expect(first).toContain('t:usdt:n0');
    expect(first).toContain('u:n');
    expect(first).toContain('u:b');
    expect(first).not.toContain('u:p');
    expect(first.filter((data) => data.startsWith('t:usdt:'))).toHaveLength(CURRENCY_PAGE_SIZE);

    const secondPage = selectCurrencies(matches, {
      query: '',
      page: 1,
      catalog: 'all',
      stage: 'network',
      ticker: 'usdt',
      networkScope: 'all',
    });
    const second = currencyKeyboard('to', secondPage)
      .inline_keyboard.flat()
      .flatMap((button) =>
        'callback_data' in button && button.callback_data ? [button.callback_data] : [],
      );
    expect(second).toContain('u:p');
    expect(second).not.toContain('u:n');
    expect(second.filter((data) => data.startsWith('t:usdt:'))).toHaveLength(1);
    for (const data of [...tokens, ...first, ...second]) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64);
    }
  });
});

describe('главное меню', () => {
  it('без кнопки виджета оставляет прежний порядок', () => {
    const rows = mainMenuKeyboard().inline_keyboard;
    expect(rows[0]).toEqual([
      { text: '📤 Отправить', callback_data: 'm:new' },
      { text: '📥 Получить', callback_data: 'm:rcv' },
    ]);
    expect(rows.some((row) => row.some((button) => 'web_app' in button || 'url' in button))).toBe(
      false,
    );
  });

  it('открывает виджет ссылкой в браузере', () => {
    const url =
      'https://changenow.io/embeds/exchange-widget/v2/widget.html?from=usdttrc20&to=usdttrc20';
    const rows = mainMenuKeyboard({ url, webApp: false }).inline_keyboard;
    expect(rows[1]).toEqual([{ text: 'Открыть обмен', url }]);
  });

  it('публичный https открывает окном Telegram', () => {
    const url = 'https://exchange.example.com/widget';
    const rows = mainMenuKeyboard({ url, webApp: true }).inline_keyboard;
    expect(rows[1]).toEqual([{ text: 'Открыть обмен', web_app: { url } }]);
  });
});
