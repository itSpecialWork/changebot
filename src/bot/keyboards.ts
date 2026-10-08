import { InlineKeyboard } from 'grammy';
import type { ExchangeRecord } from '../domain/exchanges/exchange.js';
import type { ProviderCurrency } from '../domain/exchanges/exchange-provider.js';
import { isTerminalStatus } from '../domain/exchanges/status-transitions.js';
import { callbackData, isCallbackSafeCode } from './callback-data.js';
import { formatListButton } from './format.js';

/** Максимум кнопок валют на экран. Постраничный выбор появится вместе с реальным каталогом. */
const MAX_CURRENCY_BUTTONS = 48;

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
  currencies: readonly ProviderCurrency[],
  kind: 'from' | 'to',
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const visible = currencies
    .filter((c) => isCallbackSafeCode(c.ticker) && isCallbackSafeCode(c.network))
    .slice(0, MAX_CURRENCY_BUTTONS);
  visible.forEach((currency, index) => {
    keyboard.text(
      `${currency.ticker.toUpperCase()}${currency.ticker === currency.network ? '' : ` · ${currency.network}`}`,
      callbackData[kind](currency.ticker, currency.network),
    );
    if (index % 2 === 1) keyboard.row();
  });
  return keyboard.row().text('❌ Отмена', callbackData.menu);
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
