import { InlineKeyboard } from 'grammy';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import type { ProviderCurrency } from '../../domain/exchanges/exchange-provider.js';
import { isTerminalStatus } from '../../domain/exchanges/status-transitions.js';
import { callbackData, isCallbackSafeCode } from './callback-data.js';
import { formatListButton } from './format.js';

/** Сколько валют помещается на один экран кнопок. */
export const CURRENCY_PAGE_SIZE = 48;

export interface CurrencySelection {
  readonly mode: 'all' | 'featured' | 'search';
  readonly items: readonly ProviderCurrency[];
  readonly page: number;
  readonly pageCount: number;
}

/**
 * Страница валют для кнопок.
 * Короткий каталог показывается целиком. Длинный без запроса — только featured.
 * Небезопасные тикер и сеть в кнопки не попадают: callback их не примет.
 */
export function selectCurrencies(
  currencies: readonly ProviderCurrency[],
  state: { readonly query: string; readonly page: number },
): CurrencySelection {
  const safe = currencies.filter(
    (currency) => isCallbackSafeCode(currency.ticker) && isCallbackSafeCode(currency.network),
  );
  const query = state.query.trim().toLowerCase();
  let mode: CurrencySelection['mode'];
  let pool: readonly ProviderCurrency[];
  if (query !== '') {
    mode = 'search';
    pool = safe.filter(
      (currency) => currency.ticker.includes(query) || currency.name.toLowerCase().includes(query),
    );
  } else if (safe.length <= CURRENCY_PAGE_SIZE) {
    mode = 'all';
    pool = safe;
  } else {
    mode = 'featured';
    pool = safe.filter((currency) => currency.featured);
  }

  const pageCount = Math.max(1, Math.ceil(pool.length / CURRENCY_PAGE_SIZE));
  const page = Math.min(Math.max(state.page, 0), pageCount - 1);
  const start = page * CURRENCY_PAGE_SIZE;
  return { mode, items: pool.slice(start, start + CURRENCY_PAGE_SIZE), page, pageCount };
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
  return keyboard.text('❌ Отмена', callbackData.menu);
}

function currencyButtonLabel(currency: ProviderCurrency): string {
  const ticker = currency.ticker.toUpperCase();
  return currency.ticker === currency.network ? ticker : `${ticker} · ${currency.network}`;
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
    .row()
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
