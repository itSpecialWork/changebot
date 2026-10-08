/**
 * Тексты сообщений бота (HTML parse mode). Все значения, пришедшие извне
 * (адреса, memo, тикеры), экранируются.
 */
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
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
}

/** Карточка обмена: содержимое зависит от статуса. */
export function renderExchangeCard(exchange: ExchangeRecord, options: CardOptions): string {
  const lines: string[] = [];
  if (options.demo) lines.push(DEMO_BANNER, '');

  lines.push(
    `<b>Обмен ${escapeHtml(formatPair(exchange))}</b>`,
    `Статус: ${STATUS_LABELS[exchange.status]}`,
    '',
    `Отдаёте: <b>${escapeHtml(exchange.expectedFromAmount)} ${escapeHtml(formatCurrency(exchange.fromCurrency, exchange.fromNetwork))}</b>`,
  );

  const toLabel = escapeHtml(formatCurrency(exchange.toCurrency, exchange.toNetwork));
  if (exchange.status === 'FINISHED' && exchange.actualToAmount !== null) {
    lines.push(`Получено: <b>${escapeHtml(exchange.actualToAmount)} ${toLabel}</b>`);
  } else if (exchange.expectedToAmount !== null) {
    const approx = exchange.rateType === 'FLOATING' ? '≈ ' : '';
    lines.push(`Получите: <b>${approx}${escapeHtml(exchange.expectedToAmount)} ${toLabel}</b>`);
  }
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
    case 'WAITING_DEPOSIT':
      lines.push('', ...depositLines(exchange));
      break;
    case 'FAILED':
      lines.push(
        '',
        'Если вы уже отправляли средства, обратитесь в поддержку и назовите ID обмена.',
      );
      break;
    default:
      break;
  }

  lines.push('', `ID: <code>${escapeHtml(exchange.id.slice(-8))}</code>`);
  return lines.join('\n');
}

function rateLine(exchange: ExchangeRecord): string {
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
  lines.push('', 'Мы сообщим, когда средства поступят и обмен продвинется дальше.');
  return lines;
}

/** Подсказка о том, куда придут средства (шаг ввода адреса). */
export function payoutPrompt(toLabel: string, demo: boolean): string {
  const example = demo
    ? '\n\nДля теста подойдёт любая строка из 10–128 символов, например <code>mock-payout-address-1</code>.'
    : '';
  return `Отправьте адрес кошелька <b>${escapeHtml(toLabel)}</b>, на который придут средства.${example}`;
}
