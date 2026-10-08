/**
 * Данные inline-кнопок. Telegram ограничивает callback_data 64 байтами, поэтому
 * формат короткий: `<тип>:<параметры>`. Любые данные от клиента считаются недоверенными:
 * разбор строгий, всё нераспознанное превращается в undefined.
 */
import type { RateType } from '../../domain/exchanges/exchange-provider.js';

export type CallbackAction =
  | { readonly kind: 'menu' }
  | { readonly kind: 'new' }
  | { readonly kind: 'list' }
  | { readonly kind: 'help' }
  | { readonly kind: 'from'; readonly ticker: string; readonly network: string }
  | { readonly kind: 'to'; readonly ticker: string; readonly network: string }
  | { readonly kind: 'rate'; readonly rateType: RateType }
  | { readonly kind: 'skip_extra_id' }
  | { readonly kind: 'open'; readonly exchangeId: string }
  | { readonly kind: 'prepare'; readonly exchangeId: string }
  | { readonly kind: 'confirm'; readonly exchangeId: string }
  | { readonly kind: 'cancel'; readonly exchangeId: string }
  | { readonly kind: 'demo'; readonly exchangeId: string }
  | { readonly kind: 'currency_page'; readonly direction: 'next' | 'prev' }
  | { readonly kind: 'currency_catalog'; readonly catalog: 'popular' | 'all' };

const MAX_CALLBACK_BYTES = 64;
const CODE = '[a-z0-9_-]{1,20}';
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

const SIMPLE: Readonly<Record<string, CallbackAction>> = {
  'm:menu': { kind: 'menu' },
  'm:new': { kind: 'new' },
  'm:list': { kind: 'list' },
  'm:help': { kind: 'help' },
  's:skip': { kind: 'skip_extra_id' },
  'r:F': { kind: 'rate', rateType: 'FLOATING' },
  'r:X': { kind: 'rate', rateType: 'FIXED' },
  'u:n': { kind: 'currency_page', direction: 'next' },
  'u:p': { kind: 'currency_page', direction: 'prev' },
  'u:h': { kind: 'currency_catalog', catalog: 'popular' },
  'u:a': { kind: 'currency_catalog', catalog: 'all' },
};

const CURRENCY_PATTERN = new RegExp(`^([ft]):(${CODE}):(${CODE})$`);
const EXCHANGE_PATTERN = new RegExp(`^([opcxd]):(${UUID})$`);

const EXCHANGE_KINDS = {
  o: 'open',
  p: 'prepare',
  c: 'confirm',
  x: 'cancel',
  d: 'demo',
} as const;

const SAFE_CODE_PATTERN = new RegExp(`^${CODE}$`);

/** Можно ли передать тикер/сеть в callback_data. Остальные валюты в кнопках не показываются. */
export function isCallbackSafeCode(value: string): boolean {
  return SAFE_CODE_PATTERN.test(value);
}

export function parseCallbackData(data: string): CallbackAction | undefined {
  if (Object.hasOwn(SIMPLE, data)) return SIMPLE[data];

  const currency = CURRENCY_PATTERN.exec(data);
  if (currency) {
    const [, prefix, ticker = '', network = ''] = currency;
    return { kind: prefix === 'f' ? 'from' : 'to', ticker, network };
  }

  const exchange = EXCHANGE_PATTERN.exec(data);
  if (exchange) {
    const [, prefix = '', exchangeId = ''] = exchange;
    const kind = EXCHANGE_KINDS[prefix as keyof typeof EXCHANGE_KINDS];
    return { kind, exchangeId };
  }
  return undefined;
}

/** Собирает callback_data; бросает ошибку, если значение не помещается в лимит Telegram. */
function checked(data: string): string {
  if (Buffer.byteLength(data, 'utf8') > MAX_CALLBACK_BYTES) {
    throw new Error('callback_data exceeds 64 bytes');
  }
  return data;
}

export const callbackData = {
  menu: 'm:menu',
  newExchange: 'm:new',
  list: 'm:list',
  help: 'm:help',
  skipExtraId: 's:skip',
  rate: (rateType: RateType): string => (rateType === 'FIXED' ? 'r:X' : 'r:F'),
  from: (ticker: string, network: string): string => checked(`f:${ticker}:${network}`),
  to: (ticker: string, network: string): string => checked(`t:${ticker}:${network}`),
  open: (exchangeId: string): string => checked(`o:${exchangeId}`),
  prepare: (exchangeId: string): string => checked(`p:${exchangeId}`),
  confirm: (exchangeId: string): string => checked(`c:${exchangeId}`),
  cancel: (exchangeId: string): string => checked(`x:${exchangeId}`),
  demo: (exchangeId: string): string => checked(`d:${exchangeId}`),
  currencyNext: 'u:n',
  currencyPrev: 'u:p',
  currencyPopular: 'u:h',
  currencyAll: 'u:a',
} as const;
