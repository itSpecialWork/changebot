/**
 * Уведомление «статус обмена изменился»: формирование записи outbox и текст сообщения.
 *
 * В payload попадают только идентификатор обмена, статусы и тикеры валют.
 * Адреса, memo/extraId, хэши транзакций, суммы и данные провайдера в outbox не кладутся:
 * их пользователь видит в боте по запросу, а в очереди им делать нечего.
 */
import { z } from 'zod';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import {
  EXCHANGE_STATUSES,
  type ExchangeStatus,
} from '../../domain/exchanges/status-transitions.js';
import type { NotificationDraft } from './notification-repository.js';

export const EXCHANGE_STATUS_CHANGED = 'EXCHANGE_STATUS_CHANGED';

/**
 * Статусы, о которых пишем в чат сами по себе. DRAFT, QUOTED, AWAITING_CONFIRMATION
 * и CREATING пользователь видит сам в диалоге. EXCHANGING и SENDING после уже
 * отправленного «видим платёж» не пишем: между ним и финалом они ничего не решают.
 *
 * Если опрос не увидел CONFIRMING и первым после WAITING_DEPOSIT пришёл
 * EXCHANGING или SENDING, это и есть «видим платёж» — тем же текстом.
 */
const DEPOSIT_SEEN_LINES = [
  'Видим ваш платёж.',
  'Средства будут зачислены в течение короткого времени.',
] as const;

const STATUS_BODIES = {
  WAITING_DEPOSIT: ['Заявка создана.', 'Отправьте средства по инструкции в карточке.'],
  CONFIRMING: DEPOSIT_SEEN_LINES,
  FINISHED: ['Обмен завершён.', 'Средства отправлены на ваш адрес.'],
  FAILED: [
    'Обмен не удался.',
    'Если вы уже отправляли средства, откройте «Служба поддержки» и назовите номер заявки.',
  ],
  REFUNDED: ['Средства по этой заявке возвращены.'],
  VERIFYING: ['Заявка на проверке.', 'Напишем, когда появится результат.'],
  EXPIRED: ['Срок заявки истёк.', 'Если вы не отправляли средства, ничего делать не нужно.'],
} as const satisfies Partial<Record<ExchangeStatus, readonly string[]>>;

const STATUS_EMOJI = {
  WAITING_DEPOSIT: '⏳',
  CONFIRMING: '💳',
  FINISHED: '✅',
  FAILED: '❌',
  REFUNDED: '↩️',
  VERIFYING: '🔍',
  EXPIRED: '⌛',
} as const satisfies Record<keyof typeof STATUS_BODIES, string>;

type NotifiableStatus = keyof typeof STATUS_BODIES;

/** Промежуточные статусы, которые в чат пишем только как пропущенный CONFIRMING. */
const DEPOSIT_SEEN_SKIPPED = ['EXCHANGING', 'SENDING'] as const;

type DepositSeenSkipped = (typeof DEPOSIT_SEEN_SKIPPED)[number];

function isNotifiable(status: ExchangeStatus): status is NotifiableStatus {
  return Object.hasOwn(STATUS_BODIES, status);
}

function isDepositSeenSkipped(status: ExchangeStatus): status is DepositSeenSkipped {
  return (DEPOSIT_SEEN_SKIPPED as readonly ExchangeStatus[]).includes(status);
}

function shouldNotify(from: ExchangeStatus, to: ExchangeStatus): boolean {
  if (isNotifiable(to)) return true;
  return from === 'WAITING_DEPOSIT' && isDepositSeenSkipped(to);
}

function messageFor(
  status: ExchangeStatus,
): { readonly emoji: string; readonly lines: readonly string[] } | undefined {
  if (isNotifiable(status)) {
    return { emoji: STATUS_EMOJI[status], lines: STATUS_BODIES[status] };
  }
  if (isDepositSeenSkipped(status)) {
    return { emoji: STATUS_EMOJI.CONFIRMING, lines: DEPOSIT_SEEN_LINES };
  }
  return undefined;
}

const exchangeStatusSchema = z.enum(EXCHANGE_STATUSES);

export const exchangeStatusChangedPayloadSchema = z.object({
  exchangeId: z.uuid(),
  fromStatus: exchangeStatusSchema,
  toStatus: exchangeStatusSchema,
  fromCurrency: z.string().min(1),
  toCurrency: z.string().min(1),
});

export type ExchangeStatusChangedPayload = z.infer<typeof exchangeStatusChangedPayloadSchema>;

/**
 * Запись outbox для перехода `exchange.status` → `to`
 * или undefined, если об этом статусе уведомлять не нужно.
 */
export function buildExchangeStatusNotification(
  exchange: ExchangeRecord,
  to: ExchangeStatus,
): NotificationDraft | undefined {
  if (!shouldNotify(exchange.status, to)) return undefined;
  const payload: ExchangeStatusChangedPayload = {
    exchangeId: exchange.id,
    fromStatus: exchange.status,
    toStatus: to,
    fromCurrency: exchange.fromCurrency,
    toCurrency: exchange.toCurrency,
  };
  return { type: EXCHANGE_STATUS_CHANGED, payload };
}

export class InvalidNotificationError extends Error {
  constructor(public readonly code: 'unknown_type' | 'invalid_payload') {
    super(`Notification cannot be rendered: ${code}`);
    this.name = 'InvalidNotificationError';
  }
}

/** Текст сообщения. Бросает InvalidNotificationError для неизвестного типа или битого payload. */
export function renderNotification(type: string, payload: unknown): string {
  if (type !== EXCHANGE_STATUS_CHANGED) {
    throw new InvalidNotificationError('unknown_type');
  }
  const parsed = exchangeStatusChangedPayloadSchema.safeParse(payload);
  const message = parsed.success ? messageFor(parsed.data.toStatus) : undefined;
  if (!parsed.success || message === undefined) {
    throw new InvalidNotificationError('invalid_payload');
  }
  const { exchangeId, fromCurrency, toCurrency } = parsed.data;
  const pair = `${fromCurrency.toUpperCase()} → ${toCurrency.toUpperCase()}`;
  const order = exchangeId.slice(-8);
  return [`${message.emoji} Обмен ${pair}`, '', `Заявка: ${order}`, '', ...message.lines].join(
    '\n',
  );
}
