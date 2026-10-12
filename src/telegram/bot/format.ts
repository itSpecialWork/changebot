/**
 * Тексты сообщений бота (HTML parse mode). Все значения, пришедшие извне
 * (адреса, memo, тикеры), экранируются.
 */
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import { isSameAsset } from '../../domain/exchanges/private-transfer-provider.js';
import type { ExchangeStatus } from '../../domain/exchanges/status-transitions.js';

export function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

export const STATUS_LABELS: Readonly<Record<ExchangeStatus, string>> = {
  DRAFT: '📝 Черновик',
  QUOTED: '💬 Котировка получена',
  AWAITING_CONFIRMATION: '⏸ Ждёт вашего подтверждения',
  CREATING: '⚙️ Создаётся',
  WAITING_DEPOSIT: '⏳ Ожидаем ваш платёж',
  CONFIRMING: '🔄 Ждём подтверждения сети',
  EXCHANGING: '💱 Выполняется обмен',
  SENDING: '📤 Отправляем средства',
  FINISHED: '✅ Завершён',
  FAILED: '❌ Не удался',
  REFUNDED: '↩️ Средства возвращены',
  VERIFYING: '🔍 Проверяется провайдером',
  EXPIRED: '⌛ Истёк или отменён',
};

const STATUS_EMOJI: Readonly<Record<ExchangeStatus, string>> = {
  DRAFT: '📝',
  QUOTED: '💬',
  AWAITING_CONFIRMATION: '⏸',
  CREATING: '⚙️',
  WAITING_DEPOSIT: '⏳',
  CONFIRMING: '🔄',
  EXCHANGING: '💱',
  SENDING: '📤',
  FINISHED: '✅',
  FAILED: '❌',
  REFUNDED: '↩️',
  VERIFYING: '🔍',
  EXPIRED: '⌛',
};

export const DEMO_BANNER =
  '🧪 <b>Тестовый режим.</b> Реальные средства не используются, курсы и адреса вымышленные.';

export function statusEmoji(status: ExchangeStatus): string {
  return STATUS_EMOJI[status];
}

/**
 * Как сеть выглядит в кнопке и тексте. Код провайдера сохраняется в callback.
 * ChangeNOW называет BNB Smart Chain `bsc`, в интерфейсе это BNB.
 */
const NETWORK_LABELS: Readonly<Record<string, string>> = {
  bsc: 'bnb',
};

export function networkLabel(network: string): string {
  return NETWORK_LABELS[network] ?? network;
}

/** "USDT (trx)"; сеть не повторяется, если совпадает с тикером ("BTC"). */
export function formatCurrency(ticker: string, network: string): string {
  const name = ticker.toUpperCase();
  const net = networkLabel(network);
  return ticker === network || name.toLowerCase() === net ? name : `${name} (${net})`;
}

export function formatPair(exchange: Pick<ExchangeRecord, 'fromCurrency' | 'toCurrency'>): string {
  return `${exchange.fromCurrency.toUpperCase()} → ${exchange.toCurrency.toUpperCase()}`;
}

const timeFormat = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

export function formatTime(date: Date): string {
  return `${timeFormat.format(date)} UTC`;
}

/** Строка кнопки списка: "✅ USDT → BTC · 100". */
export function formatListButton(exchange: ExchangeRecord): string {
  return `${statusEmoji(exchange.status)} ${formatPair(exchange)} · ${exchange.expectedFromAmount}`;
}

export interface CardOptions {
  readonly demo: boolean;
  /** Хеши транзакций. На обычной карточке их нет: только по кнопке полной квитанции. */
  readonly fullReceipt?: boolean;
}

/**
 * Заявка уже создана: одна квитанция на всё время оплаты.
 * Пока средства не зачислены, статус остаётся «В ожидании».
 * После зачисления та же карточка показывает «Успешно».
 */
const RECEIPT_STATUSES: ReadonlySet<ExchangeStatus> = new Set([
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'VERIFYING',
  'FINISHED',
  'FAILED',
  'REFUNDED',
]);

/** Карточка заявки: до оплаты — диалог, дальше — одна квитанция. */
export function renderExchangeCard(exchange: ExchangeRecord, options: CardOptions): string {
  const lines: string[] = [];
  if (options.demo) lines.push(DEMO_BANNER, '');

  if (RECEIPT_STATUSES.has(exchange.status)) {
    lines.push(cardTitle(exchange), '', ...receiptLines(exchange, options.fullReceipt === true));
    if (exchange.status === 'WAITING_DEPOSIT') {
      lines.push('', ...depositLines(exchange));
    } else if (exchange.status === 'FAILED') {
      lines.push(
        '',
        'Если вы уже отправляли средства, откройте «Служба поддержки» в меню и назовите ID из квитанции.',
      );
    }
    return lines.join('\n');
  }

  lines.push(
    cardTitle(exchange),
    `Статус: ${STATUS_LABELS[exchange.status]}`,
    '',
    sentAmountLine(exchange, 'Отдаёте'),
  );
  const receive = receiveAmountLine(exchange);
  if (receive !== undefined) lines.push(receive);
  lines.push(rateLine(exchange));

  switch (exchange.status) {
    case 'DRAFT':
    case 'QUOTED':
      lines.push('', 'Нажмите «Продолжить», чтобы получить актуальную котировку.');
      break;
    case 'AWAITING_CONFIRMATION':
      lines.push(
        '',
        ...payoutLines(exchange),
        '',
        '⚠️ Проверьте адрес и сеть: ошибочный перевод вернуть нельзя.',
      );
      break;
    case 'CREATING':
      lines.push('', 'Обмен создаётся у провайдера. Обновите карточку через минуту.');
      break;
    default:
      break;
  }

  lines.push('', `ID: <code>${escapeHtml(exchange.id.slice(-8))}</code>`);
  return lines.join('\n');
}

/**
 * Цельный блок квитанции. Цвет шрифта Bot API не задаёт:
 * ожидание рисуется курсивом, успешное зачисление — жирным.
 */
function receiptLines(exchange: ExchangeRecord, fullReceipt: boolean): string[] {
  const lines = [
    '<blockquote><b>Квитанция</b>',
    'Адрес получателя',
    `<code>${escapeHtml(exchange.payoutAddress ?? '—')}</code>`,
  ];
  if (exchange.payoutExtraId !== null) {
    lines.push(`Memo/Tag: <code>${escapeHtml(exchange.payoutExtraId)}</code>`);
  }
  lines.push('', sentAmountLine(exchange, 'Сумма'));
  const receive = receiveAmountLine(exchange);
  if (receive !== undefined) lines.push(receive);
  lines.push(receiptTimingLine(exchange), `Статус: ${receiptStatusHtml(exchange.status)}`);
  lines.push(`ID: <code>${escapeHtml(exchange.id)}</code></blockquote>`);
  if (fullReceipt) lines.push(...proofLines(exchange));
  return lines;
}

/**
 * Хеш выплаты на полной квитанции. Свёрнутый блок не растягивает карточку,
 * пока пользователь его не раскроет. Хеш депозита в текст не входит.
 */
function proofLines(exchange: ExchangeRecord): string[] {
  const lines: string[] = [];
  appendCollapsedHash(lines, 'Хэш выплаты', exchange.payoutHash);
  appendCollapsedHash(lines, 'Хэш возврата', exchange.refundHash);
  return lines;
}

function appendCollapsedHash(lines: string[], label: string, value: string | null): void {
  if (value === null) return;
  lines.push('', `<blockquote expandable>${label}\n<code>${escapeHtml(value)}</code></blockquote>`);
}

/** Есть что показать по кнопке полной квитанции. Хеш депозита для этого не считается. */
export function hasReceiptProof(
  exchange: Pick<ExchangeRecord, 'payoutHash' | 'refundHash'>,
): boolean {
  return exchange.payoutHash !== null || exchange.refundHash !== null;
}

function receiptStatusHtml(status: ExchangeStatus): string {
  switch (status) {
    case 'FINISHED':
      return '<b>Успешно</b>';
    case 'FAILED':
      return 'Не удался';
    case 'REFUNDED':
      return 'Средства возвращены';
    default:
      return '<i>В ожидании</i>';
  }
}

function sentAmountLine(exchange: ExchangeRecord, label: string): string {
  const amount = exchange.actualFromAmount ?? exchange.expectedFromAmount;
  const asset = escapeHtml(formatCurrency(exchange.fromCurrency, exchange.fromNetwork));
  return `${label}: <b>${escapeHtml(amount)} ${asset}</b>`;
}

function receiveAmountLine(exchange: ExchangeRecord): string | undefined {
  const toLabel = escapeHtml(formatCurrency(exchange.toCurrency, exchange.toNetwork));
  if (exchange.status === 'FINISHED' && exchange.actualToAmount !== null) {
    return `Получено: <b>${escapeHtml(exchange.actualToAmount)} ${toLabel}</b>`;
  }
  if (exchange.expectedToAmount !== null) {
    const approx = exchange.rateType === 'FLOATING' ? '≈ ' : '';
    return `Получите: <b>${approx}${escapeHtml(exchange.expectedToAmount)} ${toLabel}</b>`;
  }
  return undefined;
}

function isTransfer(exchange: ExchangeRecord): boolean {
  return isSameAsset(
    exchange.fromCurrency,
    exchange.fromNetwork,
    exchange.toCurrency,
    exchange.toNetwork,
  );
}

function cardTitle(exchange: ExchangeRecord): string {
  if (isTransfer(exchange)) {
    const asset = escapeHtml(formatCurrency(exchange.fromCurrency, exchange.fromNetwork));
    return `<b>Перевод ${asset}</b>`;
  }
  return `<b>Обмен ${escapeHtml(formatPair(exchange))}</b>`;
}

/**
 * На успешном чеке срок котировки уже ни о чём не говорит.
 * Время — момент, когда заявка перешла в «Успешно».
 */
function receiptTimingLine(exchange: ExchangeRecord): string {
  if (exchange.status === 'FINISHED' && exchange.statusChangedAt instanceof Date) {
    return `Время отправки: ${formatTime(exchange.statusChangedAt)}`;
  }
  return rateLine(exchange);
}

function rateLine(exchange: ExchangeRecord): string {
  if (isTransfer(exchange)) {
    const until = exchange.quoteExpiresAt
      ? ` Суммы действуют до ${formatTime(exchange.quoteExpiresAt)}.`
      : '';
    return `Без конвертации.${until}`;
  }
  if (exchange.rateType === 'FIXED') {
    const until = exchange.quoteExpiresAt
      ? `, действует до ${formatTime(exchange.quoteExpiresAt)}`
      : '';
    return `Курс: фиксированный${until}`;
  }
  return 'Курс: плавающий (итоговая сумма может немного отличаться)';
}

function payoutLines(exchange: ExchangeRecord): string[] {
  const lines = [
    `Адрес получения (${escapeHtml(formatCurrency(exchange.toCurrency, exchange.toNetwork))}):`,
    `<code>${escapeHtml(exchange.payoutAddress ?? '—')}</code>`,
  ];
  if (exchange.payoutExtraId !== null) {
    lines.push(`Memo/Tag: <code>${escapeHtml(exchange.payoutExtraId)}</code>`);
  }
  return lines;
}

function depositLines(exchange: ExchangeRecord): string[] {
  const from = escapeHtml(formatCurrency(exchange.fromCurrency, exchange.fromNetwork));
  const lines = [
    `Отправьте ровно <b>${escapeHtml(exchange.expectedFromAmount)} ${from}</b> на адрес:`,
    `<code>${escapeHtml(exchange.payinAddress ?? '—')}</code>`,
  ];
  if (exchange.payinExtraId !== null) {
    lines.push(`Memo/Tag (обязательно): <code>${escapeHtml(exchange.payinExtraId)}</code>`);
  }
  lines.push(
    '',
    isTransfer(exchange)
      ? 'Мы сообщим, когда средства поступят и перевод продвинется дальше.'
      : 'Мы сообщим, когда средства поступят и обмен продвинется дальше.',
  );
  return lines;
}

/** Подсказка о том, куда придут средства (шаг ввода адреса). */
export function payoutPrompt(toLabel: string, demo: boolean): string {
  const example = demo
    ? '\n\nДля теста подойдёт любая строка из 10–128 символов, например <code>mock-payout-address-1</code>.'
    : '';
  return `Отправьте адрес кошелька <b>${escapeHtml(toLabel)}</b>, на который придут средства.${example}`;
}
