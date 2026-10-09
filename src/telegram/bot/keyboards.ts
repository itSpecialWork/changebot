import { InlineKeyboard } from 'grammy';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import type { ProviderCurrency } from '../../domain/exchanges/exchange-provider.js';
import { isTerminalStatus } from '../../domain/exchanges/status-transitions.js';
import { callbackData, isCallbackSafeCode } from './callback-data.js';
import { formatListButton, networkLabel } from './format.js';

/** Сколько валют помещается на страницу полного каталога. */
export const CURRENCY_PAGE_SIZE = 48;

/** Сколько подсказок показывать, пока пользователь набирает тикер. */
export const CURRENCY_SUGGESTION_SIZE = 8;

/**
 * Короткий список на шаге выбора валюты.
 * Порядок — как на кнопках. Монеты, которых нет в каталоге, пропускаются.
 * USDT в сети BNB у ChangeNOW имеет код `bsc`; если его нет, берётся `bnb`.
 */
export const POPULAR_PAIRS: readonly {
  readonly ticker: string;
  readonly networks: readonly string[];
}[] = [
  { ticker: 'usdt', networks: ['trx'] },
  { ticker: 'trx', networks: ['trx'] },
  { ticker: 'btc', networks: ['btc'] },
  { ticker: 'eth', networks: ['eth'] },
  { ticker: 'usdt', networks: ['eth'] },
  { ticker: 'usdt', networks: ['bsc', 'bnb'] },
  { ticker: 'sol', networks: ['sol'] },
  { ticker: 'ton', networks: ['ton'] },
  { ticker: 'ltc', networks: ['ltc'] },
  { ticker: 'xrp', networks: ['xrp'] },
];

/** Подпись кнопки для пар, где код сети провайдера непонятен пользователю. */
const PAIR_BUTTON_LABELS: Readonly<Record<string, string>> = {
  'usdt:trx': 'USDT · TRC20',
  'usdt:eth': 'USDT · ERC20',
  'usdt:bsc': 'USDT · BEP20',
  'usdt:bnb': 'USDT · BEP20',
};

export type CurrencyCatalog = 'popular' | 'all';

export interface CurrencySelection {
  readonly mode: 'all' | 'popular' | 'search';
  readonly items: readonly ProviderCurrency[];
  readonly page: number;
  readonly pageCount: number;
}

function popularCurrencies(currencies: readonly ProviderCurrency[]): ProviderCurrency[] {
  const byKey = new Map(
    currencies.map((currency) => [`${currency.ticker}:${currency.network}`, currency]),
  );
  const picked: ProviderCurrency[] = [];
  for (const pair of POPULAR_PAIRS) {
    for (const network of pair.networks) {
      const currency = byKey.get(`${pair.ticker}:${network}`);
      if (currency) {
        picked.push(currency);
        break;
      }
    }
  }
  return picked;
}

/**
 * Насколько валюта подходит запросу.
 * 0 — тикер целиком, 1 — тикер с этих букв, 2 — тикер содержит,
 * 3 — название с этих букв, 4 — название содержит.
 */
function matchRank(currency: ProviderCurrency, query: string): number | undefined {
  const ticker = currency.ticker.toLowerCase();
  const name = currency.name.toLowerCase();
  if (ticker === query) return 0;
  if (ticker.startsWith(query)) return 1;
  if (ticker.includes(query)) return 2;
  if (name.startsWith(query)) return 3;
  if (name.includes(query)) return 4;
  return undefined;
}

function popularIndex(currency: ProviderCurrency): number {
  const index = POPULAR_PAIRS.findIndex(
    (pair) => pair.ticker === currency.ticker && pair.networks.includes(currency.network),
  );
  return index === -1 ? POPULAR_PAIRS.length : index;
}

/**
 * Подсказки по вводу.
 * Если есть монеты, чей тикер начинается с запроса, остальные совпадения скрыты:
 * буква «x» показывает XLM и XRP, а не любое название с этой буквой.
 */
function searchCurrencies(
  currencies: readonly ProviderCurrency[],
  query: string,
): ProviderCurrency[] {
  const ranked = currencies.flatMap((currency) => {
    const rank = matchRank(currency, query);
    return rank === undefined ? [] : [{ currency, rank }];
  });
  const prefix = ranked.some((item) => item.rank <= 1);
  const matches = prefix ? ranked.filter((item) => item.rank <= 1) : ranked;
  return matches
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const popular = popularIndex(a.currency) - popularIndex(b.currency);
      if (popular !== 0) return popular;
      const ticker = a.currency.ticker.localeCompare(b.currency.ticker);
      if (ticker !== 0) return ticker;
      return a.currency.network.localeCompare(b.currency.network);
    })
    .map((item) => item.currency);
}

/**
 * Страница валют для кнопок.
 * Без запроса: короткий список популярных валют или полный каталог.
 * Небезопасные тикер и сеть в кнопки не попадают: callback их не примет.
 */
export function selectCurrencies(
  currencies: readonly ProviderCurrency[],
  state: { readonly query: string; readonly page: number; readonly catalog: CurrencyCatalog },
): CurrencySelection {
  const safe = currencies.filter(
    (currency) => isCallbackSafeCode(currency.ticker) && isCallbackSafeCode(currency.network),
  );
  const query = state.query.trim().toLowerCase();
  let mode: CurrencySelection['mode'];
  let pool: readonly ProviderCurrency[];
  if (query !== '') {
    mode = 'search';
    pool = searchCurrencies(safe, query);
  } else if (state.catalog === 'popular') {
    mode = 'popular';
    pool = popularCurrencies(safe);
  } else {
    mode = 'all';
    pool = safe;
  }

  const size = mode === 'search' ? CURRENCY_SUGGESTION_SIZE : CURRENCY_PAGE_SIZE;
  const pageCount = Math.max(1, Math.ceil(pool.length / size));
  const page = Math.min(Math.max(state.page, 0), pageCount - 1);
  const start = page * size;
  return { mode, items: pool.slice(start, start + size), page, pageCount };
}

export function mainMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('🔄 Новый обмен', callbackData.newExchange)
    .row()
    .text('📋 Мои обмены', callbackData.list)
    .text('ℹ️ Помощь', callbackData.help);
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🏠 В меню', callbackData.menu);
}

/** Кнопки выбора валюты. `kind` определяет, какое действие вызовет нажатие. */
export function currencyKeyboard(
  kind: 'from' | 'to',
  selection: CurrencySelection,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const build = kind === 'from' ? callbackData.from : callbackData.to;
  selection.items.forEach((currency, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    keyboard.text(currencyButtonLabel(currency), build(currency.ticker, currency.network));
  });
  if (selection.page > 0 || selection.page + 1 < selection.pageCount) {
    breakRow(keyboard);
    if (selection.page > 0) keyboard.text('◀️ Назад', callbackData.currencyPrev);
    if (selection.page + 1 < selection.pageCount)
      keyboard.text('Дальше ▶️', callbackData.currencyNext);
  }
  breakRow(keyboard);
  if (selection.mode === 'popular') {
    keyboard.text('📋 Все валюты', callbackData.currencyAll);
  } else if (selection.mode === 'all') {
    keyboard.text('⭐ Актуальные', callbackData.currencyPopular);
  } else {
    keyboard
      .text('⭐ Актуальные', callbackData.currencyPopular)
      .text('📋 Все валюты', callbackData.currencyAll);
  }
  breakRow(keyboard);
  return keyboard.text('❌ Отмена', callbackData.menu);
}

function currencyButtonLabel(currency: ProviderCurrency): string {
  const pair = PAIR_BUTTON_LABELS[`${currency.ticker}:${currency.network}`];
  if (pair !== undefined) return pair;
  const ticker = currency.ticker.toUpperCase();
  const network = networkLabel(currency.network);
  return currency.ticker === currency.network || ticker.toLowerCase() === network
    ? ticker
    : `${ticker} · ${network}`;
}

/** Новая строка, если текущая уже не пустая. Пустые ряды Telegram не принимает. */
function breakRow(keyboard: InlineKeyboard): void {
  const last = keyboard.inline_keyboard.at(-1);
  if (last === undefined || last.length > 0) keyboard.row();
}

export function rateTypeKeyboard(fixedAvailable: boolean): InlineKeyboard {
  const keyboard = new InlineKeyboard().text('📈 Плавающий', callbackData.rate('FLOATING'));
  if (fixedAvailable) keyboard.text('🔒 Фиксированный', callbackData.rate('FIXED'));
  return keyboard.row().text('❌ Отмена', callbackData.menu);
}

export function cancelFlowKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Отмена', callbackData.menu);
}

export function skipExtraIdKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Пропустить', callbackData.skipExtraId)
    .text('❌ Отмена', callbackData.menu);
}

export function exchangeListKeyboard(exchanges: readonly ExchangeRecord[]): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const exchange of exchanges) {
    keyboard.text(formatListButton(exchange), callbackData.open(exchange.id)).row();
  }
  return keyboard
    .text('🔄 Новый обмен', callbackData.newExchange)
    .row()
    .text('🏠 В меню', callbackData.menu);
}

export interface CardKeyboardOptions {
  /** Показывать кнопку продвижения тестового провайдера. */
  readonly demo: boolean;
}

export function exchangeCardKeyboard(
  exchange: ExchangeRecord,
  options: CardKeyboardOptions,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const id = exchange.id;

  switch (exchange.status) {
    case 'DRAFT':
    case 'QUOTED':
      keyboard
        .text('▶️ Продолжить', callbackData.prepare(id))
        .text('❌ Отменить', callbackData.cancel(id));
      break;
    case 'AWAITING_CONFIRMATION':
      keyboard
        .text('✅ Подтвердить', callbackData.confirm(id))
        .text('❌ Отменить', callbackData.cancel(id));
      break;
    default:
      if (!isTerminalStatus(exchange.status)) {
        keyboard.text('🔄 Обновить', callbackData.open(id));
        if (options.demo && exchange.providerExchangeId !== null) {
          keyboard.row().text('⏩ Демо: следующий статус', callbackData.demo(id));
        }
      }
  }
  return keyboard
    .row()
    .text('📋 Мои обмены', callbackData.list)
    .text('🏠 В меню', callbackData.menu);
}
