import { describe, expect, it } from 'vitest';
import type { ProviderCurrency } from '../../../src/domain/exchanges/exchange-provider.js';
import {
  buildCurrencyCommandMenu,
  parseCurrencyCommand,
} from '../../../src/telegram/bot/currency-commands.js';

function currency(ticker: string, network: string, name: string): ProviderCurrency {
  return { ticker, network, name, extraId: 'none', supportsFixedRate: false, featured: false };
}

describe('меню команд валют', () => {
  const currencies = [
    currency('btc', 'btc', 'Bitcoin'),
    currency('trx', 'trx', 'TRON'),
    currency('usdt', 'trx', 'Tether (TRC20)'),
    currency('usdt', 'eth', 'Tether (ERC20)'),
    currency('usdt', 'bsc', 'Tether (BEP20)'),
    currency('xlm', 'xlm', 'Stellar'),
    currency('zzz', 'zzz', 'Unknown'),
  ];

  it('даёт /btc и /xlm, а разные сети USDT различает суффиксом', () => {
    const menu = buildCurrencyCommandMenu(currencies);
    const names = menu.commands.map((command) => command.command);

    expect(names).toContain('start');
    expect(names).toContain('btc');
    expect(names).toContain('trx');
    expect(names).toContain('xlm');
    expect(names).toContain('usdt_trc20');
    expect(names).toContain('usdt_erc20');
    expect(names).toContain('usdt_bep20');
    expect(names).not.toContain('usdt');
    expect(names).not.toContain('zzz');
    expect(menu.lookup.btc).toEqual({ ticker: 'btc', network: 'btc' });
    expect(menu.lookup.usdt_trc20).toEqual({ ticker: 'usdt', network: 'trx' });
    expect(menu.lookup.start).toBeUndefined();
    expect(names.length).toBeLessThanOrEqual(100);
  });

  it('читает /xlm и /xlm@bot', () => {
    expect(parseCurrencyCommand('/xlm')).toBe('xlm');
    expect(parseCurrencyCommand('/XLM@ChangeBot')).toBe('xlm');
    expect(parseCurrencyCommand('xlm')).toBeUndefined();
    expect(parseCurrencyCommand('/xlm extra')).toBeUndefined();
  });
});
