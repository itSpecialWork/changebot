import { describe, expect, it } from 'vitest';
import { matchesPayoutAddressShape } from '../../src/domain/exchanges/payout-address.js';

const SOL = 'So11111111111111111111111111111111111111112';
const TRX = 'TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE';
const ETH = '0x71C7656EC7ab88b098defB751B7401B5f6d8976F';
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';

describe('matchesPayoutAddressShape', () => {
  it('отклоняет короткую строку для SOL и принимает адрес нужной длины', () => {
    expect(matchesPayoutAddressShape('sol', 'jhghghhghgfgdgdgdg')).toBe(false);
    expect(matchesPayoutAddressShape('SOL', SOL)).toBe(true);
    expect(matchesPayoutAddressShape('sol', ETH)).toBe(false);
    // TRON — тоже base58 и ровно 34 символа, поэтому формой от SOL не отличить.
    expect(matchesPayoutAddressShape('sol', TRX)).toBe(true);
  });

  it('сверяет сеть, а не тикер монеты', () => {
    expect(matchesPayoutAddressShape('trx', TRX)).toBe(true);
    expect(matchesPayoutAddressShape('trx', SOL)).toBe(false);
    expect(matchesPayoutAddressShape('eth', ETH)).toBe(true);
    expect(matchesPayoutAddressShape('bsc', ETH)).toBe(true);
    expect(matchesPayoutAddressShape('bsc', TRX)).toBe(false);
    expect(matchesPayoutAddressShape('btc', BTC)).toBe(true);
    expect(matchesPayoutAddressShape('btc', '1' + 'A'.repeat(20))).toBe(false);
  });

  it('неизвестную сеть не блокирует', () => {
    expect(matchesPayoutAddressShape('newchain', 'jhghghhghgfgdgdgdg')).toBe(true);
  });
});
