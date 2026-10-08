/**
 * Уведомление «статус обмена изменился»: формирование записи outbox и текст сообщения.
 *
 * В payload попадают только идентификатор обмена, статусы и тикеры валют.
 * Адреса, memo/extraId, суммы и данные провайдера в outbox не кладутся:
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
 * Статусы, о которых сообщаем пользователю. DRAFT, QUOTED, AWAITING_CONFIRMATION
 * и CREATING пользователь видит сам в диалоге.
 */
const STATUS_MESSAGES = {
  WAITING_DEPOSIT: 'Обмен создан. Ожидаем поступление ваших средств.',
  CONFIRMING: 'Средства получены, ждём подтверждения сети.',
  EXCHANGING: 'Платёж подтверждён, выполняем обмен.',
  SENDING: 'Обмен выполнен, отправляем средства на ваш адрес.',
  FINISHED: 'Обмен завершён, средства отправлены на ваш адрес.',
  FAILED: 'Обмен не удался. Если вы уже отправляли средства, обратитесь в поддержку.',
  REFUNDED: 'Средства возвращены на адрес возврата.',
  VERIFYING: 'Обмен проверяется провайдером. Мы сообщим о результате.',
  EXPIRED: 'Срок действия обмена истёк.',
} as const satisfies Partial<Record<ExchangeStatus, string>>;

type NotifiableStatus = keyof typeof STATUS_MESSAGES;

function isNotifiable(status: ExchangeStatus): status is NotifiableStatus {
  return Object.hasOwn(STATUS_MESSAGES, status);
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
  if (!isNotifiable(to)) return undefined;
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
  if (!parsed.success || !isNotifiable(parsed.data.toStatus)) {
    throw new InvalidNotificationError('invalid_payload');
  }
  const { fromCurrency, toCurrency, toStatus } = parsed.data;
  const pair = `${fromCurrency.toUpperCase()} → ${toCurrency.toUpperCase()}`;
  return `Обмен ${pair}\n${STATUS_MESSAGES[toStatus]}`;
}
