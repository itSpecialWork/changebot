import { InlineKeyboard } from 'grammy';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import type { ProviderCurrency } from '../../domain/exchanges/exchange-provider.js';
import { isTerminalStatus } from '../../domain/exchanges/status-transitions.js';
import { callbackData, isCallbackSafeCode } from './callback-data.js';
import type { CurrencyStage, NetworkScope, WidgetButton } from './context.js';
import { formatListButton, hasReceiptProof, networkLabel } from './format.js';

/** Сколько валют помещается на страницу полного каталога. */
export const CURRENCY_PAGE_SIZE = 48;

/** Сколько подсказок показывать, пока пользователь набирает тикер. */
export const CURRENCY_SUGGESTION_SIZE = 8;

/**
 * Пары на первом экране обмена. Сеть уже в кнопке, отдельно её не спрашиваем.
 * USDT в сети BNB у ChangeNOW имеет код `bsc`; если его нет, берётся `bnb`.
 * Монеты, которых нет в каталоге, пропускаются.
 */
export const BASE_PAIRS: readonly {
  readonly ticker: string;
  readonly networks: readonly string[];
}[] = [
  { ticker: 'usdt', networks: ['trx'] },
  { ticker: 'usdt', networks: ['bsc', 'bnb'] },
  { ticker: 'btc', networks: ['btc'] },
  { ticker: 'trx', networks: ['trx'] },
  { ticker: 'sol', networks: ['sol'] },
];

const BASE_LABELS: Readonly<Record<string, string>> = {
  'usdt:trx': 'USDT TRX',
  'usdt:bsc': 'USDT BNB',
  'usdt:bnb': 'USDT BNB',
};

/**
 * Актуальные монеты по кнопке «Все валюты».
 * Порядок — как на кнопках. Монеты, которых нет в каталоге, пропускаются.
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

export type CurrencyCatalog = 'base' | 'popular' | 'all';

export interface CurrencySelection {
  readonly mode: 'all' | 'popular' | 'base' | 'search';
  readonly stage: CurrencyStage;
  readonly items: readonly ProviderCurrency[];
  readonly page: number;
  readonly pageCount: number;
}

export interface CurrencyListState {
  readonly query: string;
  readonly page: number;
  readonly catalog: CurrencyCatalog;
  readonly stage?: CurrencyStage;
  readonly ticker?: string;
  readonly networkScope?: NetworkScope;
}

function currencyKey(currency: ProviderCurrency): string {
  return `${currency.ticker}:${currency.network}`;
}

/** Пары из списка, которые есть в каталоге. Один пункт списка — одна кнопка. */
function pairsPresent(
  currencies: readonly ProviderCurrency[],
  pairs: readonly { readonly ticker: string; readonly networks: readonly string[] }[],
): ProviderCurrency[] {
  const byKey = new Map(currencies.map((currency) => [currencyKey(currency), currency]));
  const picked: ProviderCurrency[] = [];
  for (const pair of pairs) {
    for (const network of pair.networks) {
      const currency = byKey.get(`${pair.ticker}:${network}`);
      if (!currency) continue;
      picked.push(currency);
      break;
    }
  }
  return picked;
}

/** Сети актуального списка для одной монеты. Для USDT это TRC20, ERC20 и BEP20. */
function popularNetworksFor(
  currencies: readonly ProviderCurrency[],
  ticker: string,
): ProviderCurrency[] {
  return pairsPresent(currencies, POPULAR_PAIRS).filter((currency) => currency.ticker === ticker);
}

/** По одной кнопке на монету, в порядке короткого списка. */
function popularTokens(currencies: readonly ProviderCurrency[]): ProviderCurrency[] {
  const seen = new Set<string>();
  const picked: ProviderCurrency[] = [];
  for (const pair of POPULAR_PAIRS) {
    if (seen.has(pair.ticker)) continue;
    const first = popularNetworksFor(currencies, pair.ticker)[0];
    if (!first) continue;
    seen.add(pair.ticker);
    picked.push(first);
  }
  return picked;
}

function uniqueTokens(currencies: readonly ProviderCurrency[]): ProviderCurrency[] {
  const seen = new Set<string>();
  const picked: ProviderCurrency[] = [];
  for (const currency of currencies) {
    if (seen.has(currency.ticker)) continue;
    seen.add(currency.ticker);
    picked.push(currency);
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

/** По одному лучшему совпадению на тикер. Буква «x» показывает XRP и XLM, а не каждую их сеть. */
function searchTokens(currencies: readonly ProviderCurrency[], query: string): ProviderCurrency[] {
  const best = new Map<string, { currency: ProviderCurrency; rank: number }>();
  for (const currency of currencies) {
    const rank = matchRank(currency, query);
    if (rank === undefined) continue;
    const current = best.get(currency.ticker);
    if (
      current === undefined ||
      rank < current.rank ||
      (rank === current.rank && popularIndex(currency) < popularIndex(current.currency))
    ) {
      best.set(currency.ticker, { currency, rank });
    }
  }
  const ranked = [...best.values()];
  const prefix = ranked.some((item) => item.rank <= 1);
  const matches = prefix ? ranked.filter((item) => item.rank <= 1) : ranked;
  return matches
    .sort((a, b) => {
      if (a.rank !== b.rank) return a.rank - b.rank;
      const popular = popularIndex(a.currency) - popularIndex(b.currency);
      if (popular !== 0) return popular;
      return a.currency.ticker.localeCompare(b.currency.ticker);
    })
    .map((item) => item.currency);
}

function networksOf(currencies: readonly ProviderCurrency[], ticker: string): ProviderCurrency[] {
  return currencies.filter((currency) => currency.ticker === ticker);
}

function networkMatches(currency: ProviderCurrency, query: string): boolean {
  const label = networkButtonLabel(currency).toLowerCase();
  const network = networkLabel(currency.network).toLowerCase();
  return (
    currency.network.toLowerCase().includes(query) ||
    network.includes(query) ||
    label.includes(query) ||
    currency.name.toLowerCase().includes(query)
  );
}

function pageSlice(
  pool: readonly ProviderCurrency[],
  page: number,
  size: number,
): Pick<CurrencySelection, 'items' | 'page' | 'pageCount'> {
  const pageCount = Math.max(1, Math.ceil(pool.length / size));
  const current = Math.min(Math.max(page, 0), pageCount - 1);
  const start = current * size;
  return { items: pool.slice(start, start + size), page: current, pageCount };
}

/**
 * Страница кнопок.
 * Базовый экран — готовые пары. «Все валюты» — актуальные монеты без повтора сети.
 * Сеть открывается отдельно, только если у монеты их несколько: в актуальном списке
 * только его сети, в полном каталоге и поиске — все сети этой монеты.
 * Небезопасные тикер и сеть в кнопки не попадают: callback их не примет.
 */
export function selectCurrencies(
  currencies: readonly ProviderCurrency[],
  state: CurrencyListState,
): CurrencySelection {
  const safe = currencies.filter(
    (currency) => isCallbackSafeCode(currency.ticker) && isCallbackSafeCode(currency.network),
  );
  const query = state.query.trim().toLowerCase();
  const stage = state.stage ?? 'token';
  if (stage === 'network') {
    const ticker = state.ticker ?? '';
    const scope = state.networkScope ?? 'all';
    const base = scope === 'popular' ? popularNetworksFor(safe, ticker) : networksOf(safe, ticker);
    const pool = query === '' ? base : base.filter((currency) => networkMatches(currency, query));
    const mode = query !== '' ? 'search' : scope === 'popular' ? 'popular' : 'all';
    return { mode, stage, ...pageSlice(pool, state.page, CURRENCY_PAGE_SIZE) };
  }

  let mode: CurrencySelection['mode'];
  let pool: readonly ProviderCurrency[];
  if (query !== '') {
    mode = 'search';
    pool = searchTokens(safe, query);
  } else if (state.catalog === 'base') {
    mode = 'base';
    pool = pairsPresent(safe, BASE_PAIRS);
  } else if (state.catalog === 'popular') {
    mode = 'popular';
    pool = popularTokens(safe);
  } else {
    mode = 'all';
    pool = uniqueTokens(safe);
  }
  const size = mode === 'search' ? CURRENCY_SUGGESTION_SIZE : CURRENCY_PAGE_SIZE;
  return { mode, stage, ...pageSlice(pool, state.page, size) };
}

export function mainMenuKeyboard(widgetButton?: WidgetButton): InlineKeyboard {
  const keyboard = new InlineKeyboard()
    .text('📤 Отправить', callbackData.newExchange)
    .text('📥 Получить', callbackData.receive)
    .row();
  if (widgetButton?.webApp === true) {
    keyboard.webApp('Открыть обмен', widgetButton.url).row();
  } else if (widgetButton !== undefined) {
    keyboard.url('Открыть обмен', widgetButton.url).row();
  }
  return keyboard
    .text('📋 Мои обмены', callbackData.list)
    .row()
    .text('💬 Служба поддержки', callbackData.support)
    .row()
    .text('📄 Соглашения', callbackData.agreements)
    .text('ℹ️ Помощь', callbackData.help);
}

export function backToMenuKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('🏠 В меню', callbackData.menu);
}

/** Оглавление соглашений: каждый пункт — отдельный короткий экран. */
export function agreementsKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Условия обмена', callbackData.agreementUse)
    .row()
    .text('Риски', callbackData.agreementRisk)
    .row()
    .text('Какие данные храним', callbackData.agreementData)
    .row()
    .text('🏠 В меню', callbackData.menu);
}

/** Возврат из раздела соглашения к оглавлению. */
export function agreementSectionKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('◀️ К соглашениям', callbackData.agreements)
    .text('🏠 В меню', callbackData.menu);
}

/** Кнопки монеты или её сети. `kind` определяет, какое действие вызовет нажатие. */
export function currencyKeyboard(
  kind: 'from' | 'to',
  selection: CurrencySelection,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  selection.items.forEach((currency, index) => {
    if (index > 0 && index % 2 === 0) keyboard.row();
    if (selection.stage === 'network' || selection.mode === 'base') {
      const build = kind === 'from' ? callbackData.from : callbackData.to;
      const text =
        selection.mode === 'base' ? baseButtonLabel(currency) : networkButtonLabel(currency);
      keyboard.text(text, build(currency.ticker, currency.network));
    } else {
      keyboard.text(currency.ticker.toUpperCase(), callbackData.ticker(kind, currency.ticker));
    }
  });
  if (selection.page > 0 || selection.page + 1 < selection.pageCount) {
    breakRow(keyboard);
    if (selection.page > 0) {
      keyboard.text(selection.stage === 'network' ? '◀️' : '◀️ Назад', callbackData.currencyPrev);
    }
    if (selection.page + 1 < selection.pageCount)
      keyboard.text('Дальше ▶️', callbackData.currencyNext);
  }
  breakRow(keyboard);
  if (selection.stage === 'network') {
    return keyboard.text('Назад', callbackData.currencyBack).text('❌ Отмена', callbackData.menu);
  }
  if (selection.mode === 'base') {
    keyboard.text('📋 Все валюты', callbackData.currencyPopular);
  } else if (selection.mode === 'popular') {
    keyboard.text('Базовые', callbackData.currencyBase);
  } else if (selection.mode === 'all') {
    keyboard
      .text('Базовые', callbackData.currencyBase)
      .text('⭐ Актуальные', callbackData.currencyPopular);
  } else {
    keyboard
      .text('Базовые', callbackData.currencyBase)
      .text('📋 Все валюты', callbackData.currencyPopular);
  }
  breakRow(keyboard);
  return keyboard.text('❌ Отмена', callbackData.menu);
}

function baseButtonLabel(currency: ProviderCurrency): string {
  const known = BASE_LABELS[currencyKey(currency)];
  if (known !== undefined) return known;
  const ticker = currency.ticker.toUpperCase();
  const network = networkLabel(currency.network).toUpperCase();
  return ticker === network ? ticker : `${ticker} ${network}`;
}

function networkButtonLabel(currency: ProviderCurrency): string {
  const pair = PAIR_BUTTON_LABELS[currencyKey(currency)];
  if (pair !== undefined) {
    const separator = pair.lastIndexOf(' · ');
    return separator === -1 ? pair : pair.slice(separator + 3);
  }
  const ticker = currency.ticker.toUpperCase();
  const network = networkLabel(currency.network);
  return currency.ticker === currency.network || ticker.toLowerCase() === network
    ? ticker
    : network.toUpperCase();
}

/** Новая строка, если текущая уже не пустая. Пустые ряды Telegram не принимает. */
function breakRow(keyboard: InlineKeyboard): void {
  const last = keyboard.inline_keyboard.at(-1);
  if (last === undefined || last.length > 0) keyboard.row();
}

export function cancelFlowKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text('❌ Отмена', callbackData.menu);
}

export function skipExtraIdKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text('Пропустить', callbackData.skipExtraId)
    .text('❌ Отмена', callbackData.menu);
}

export function exchangeListKeyboard(
  exchanges: readonly ExchangeRecord[],
  options?: { readonly pendingAddress?: boolean },
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (options?.pendingAddress) {
    keyboard
      .text('Продолжить', callbackData.resumeAddress)
      .text('Отмена', callbackData.dropAddress);
    if (exchanges.length > 0) keyboard.row();
  }
  for (const exchange of exchanges) {
    keyboard.text(formatListButton(exchange), callbackData.open(exchange.id)).row();
  }
  if (exchanges.length === 0) return keyboard;
  return keyboard
    .text('📤 Отправить', callbackData.newExchange)
    .row()
    .text('🏠 В меню', callbackData.menu);
}

export interface CardKeyboardOptions {
  /** Показывать кнопку продвижения тестового провайдера. */
  readonly demo: boolean;
  /** Карточка уже открыта полной квитанцией: кнопка сворачивает хеш. */
  readonly fullReceipt?: boolean;
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
      if (hasReceiptProof(exchange)) {
        keyboard
          .row()
          .text(
            options.fullReceipt ? 'Свернуть квитанцию' : 'Полная квитанция оплаты',
            options.fullReceipt ? callbackData.receiptBrief(id) : callbackData.receipt(id),
          );
      }
  }
  return keyboard
    .row()
    .text('📋 Мои обмены', callbackData.list)
    .text('🏠 В меню', callbackData.menu);
}
