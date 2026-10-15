import { SUPPORT_LIST_LIMIT, type SupportExchange, type SupportExchangeSummary } from './lookup.js';

const STATUS_LABELS: Readonly<Record<string, string>> = {
  DRAFT: 'Черновик',
  QUOTED: 'Котировка получена',
  AWAITING_CONFIRMATION: 'Ждёт подтверждения',
  CREATING: 'Создаётся',
  WAITING_DEPOSIT: 'Ожидаем платёж',
  CONFIRMING: 'Ждём подтверждения сети',
  EXCHANGING: 'Выполняется обмен',
  SENDING: 'Отправляем средства',
  FINISHED: 'Завершён',
  FAILED: 'Не удался',
  REFUNDED: 'Средства возвращены',
  VERIFYING: 'Проверяется провайдером',
  EXPIRED: 'Истёк или отменён',
};

const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** Карточка заявки для админа. Кнопок и смены статуса здесь нет. */
export function renderSupportCard(exchange: SupportExchange): string {
  const lines = [
    '<b>Заявка поддержки</b>',
    escapeHtml(pairLine(exchange)),
    `Статус: ${escapeHtml(STATUS_LABELS[exchange.status] ?? exchange.status)}`,
    `<code>${escapeHtml(exchange.status)}</code>`,
    `Провайдер: ${escapeHtml(exchange.provider)} · ${code(exchange.providerStatus)}`,
    `Курс: ${exchange.rateType === 'FIXED' ? 'фиксированный' : 'плавающий'}`,
    '',
  ];
  pushAmount(
    lines,
    'Отправка',
    exchange.expectedFromAmount,
    exchange.fromCurrency,
    exchange.fromNetwork,
  );
  pushAmount(
    lines,
    'Факт отправки',
    exchange.actualFromAmount,
    exchange.fromCurrency,
    exchange.fromNetwork,
  );
  pushAmount(
    lines,
    'Получение',
    exchange.expectedToAmount,
    exchange.toCurrency,
    exchange.toNetwork,
  );
  pushAmount(
    lines,
    'Факт получения',
    exchange.actualToAmount,
    exchange.toCurrency,
    exchange.toNetwork,
  );
  lines.push(
    '',
    ...addressBlock('Депозит', exchange.payinAddress, exchange.payinExtraId),
    ...addressBlock('Выплата', exchange.payoutAddress, exchange.payoutExtraId),
    ...addressBlock('Возврат', exchange.refundAddress, exchange.refundExtraId),
    ...hashLine('Хеш депозита', exchange.payinHash),
    ...hashLine('Хеш выплаты', exchange.payoutHash),
    ...hashLine('Хеш возврата', exchange.refundHash),
    '',
    `ID: <code>${escapeHtml(exchange.id)}</code>`,
    `ID провайдера: ${code(exchange.providerExchangeId)}`,
    `Telegram ID: <code>${escapeHtml(exchange.telegramId)}</code>`,
    `Username: ${code(exchange.username === null ? null : `@${exchange.username}`)}`,
    `Создана: ${escapeHtml(formatTime(exchange.createdAt))}`,
    `Статус изменён: ${escapeHtml(formatTime(exchange.statusChangedAt))}`,
  );
  return lines
    .join('\n')
    .replaceAll(/\n{3,}/g, '\n\n')
    .trim();
}

/** Список заявок одного имени. Полный ID можно отправить следом, чтобы открыть карточку. */
export function renderSupportList(
  username: string,
  exchanges: readonly SupportExchangeSummary[],
  truncated: boolean,
): string {
  const title = /^\d+$/.test(username) ? username : `@${username}`;
  const lines = [`<b>Заявки ${escapeHtml(title)}</b>`];
  const telegramIds = new Set(exchanges.map((exchange) => exchange.telegramId));
  if (telegramIds.size === 1) {
    const telegramId = exchanges[0]?.telegramId;
    if (telegramId !== undefined) lines.push(`Telegram ID: <code>${escapeHtml(telegramId)}</code>`);
  }
  if (truncated) lines.push(`Показаны ${String(SUPPORT_LIST_LIMIT)} последних.`);
  lines.push('');
  for (const exchange of exchanges) {
    lines.push(
      escapeHtml(formatTime(exchange.createdAt)),
      escapeHtml(pairLine(exchange)),
      `${escapeHtml(exchange.expectedFromAmount)} · ${escapeHtml(STATUS_LABELS[exchange.status] ?? exchange.status)}`,
    );
    if (telegramIds.size > 1) {
      lines.push(`Telegram ID: <code>${escapeHtml(exchange.telegramId)}</code>`);
    }
    lines.push(`ID: <code>${escapeHtml(exchange.id)}</code>`, '');
  }
  lines.push('Пришлите ID, чтобы открыть карточку.');
  return lines.join('\n').trim();
}

function pairLine(exchange: SupportExchange | SupportExchangeSummary): string {
  return `${asset(exchange.fromCurrency, exchange.fromNetwork)} → ${asset(exchange.toCurrency, exchange.toNetwork)}`;
}

function asset(currency: string, network: string): string {
  return `${currency.toUpperCase()} / ${network}`;
}

function pushAmount(
  lines: string[],
  label: string,
  amount: string | null,
  currency: string,
  network: string,
): void {
  if (amount === null) return;
  lines.push(`${label}: <b>${escapeHtml(`${amount} ${asset(currency, network)}`)}</b>`);
}

function addressBlock(title: string, address: string | null, extraId: string | null): string[] {
  if (address === null && extraId === null) return [];
  const lines = ['', title];
  if (address !== null) lines.push(`<code>${escapeHtml(address)}</code>`);
  if (extraId !== null) lines.push(`Memo: <code>${escapeHtml(extraId)}</code>`);
  return lines;
}

function hashLine(label: string, value: string | null): string[] {
  if (value === null) return [];
  return [`${label}: <code>${escapeHtml(value)}</code>`];
}

function code(value: string | null): string {
  return value === null ? '—' : `<code>${escapeHtml(value)}</code>`;
}

function formatTime(date: Date): string {
  return `${timeFormat.format(date)} UTC`;
}
