/**
 * Квитанция вторым сообщением после финала.
 * Собирается в момент отправки: в outbox остаются только id и статусы.
 */
import { ExchangeNotFoundError } from '../../application/exchanges/errors.js';
import {
  exchangeStatusChangedPayloadSchema,
  EXCHANGE_STATUS_CHANGED,
} from '../../application/notifications/exchange-status-notification.js';
import type { ClaimedNotification } from '../../application/notifications/notification-repository.js';
import type { ExchangeRecord } from '../../domain/exchanges/exchange.js';
import { renderExchangeCard } from '../bot/format.js';

export async function finishedReceiptText(
  notification: ClaimedNotification,
  load: (userId: string, exchangeId: string) => Promise<ExchangeRecord>,
  demo: boolean,
): Promise<string | undefined> {
  if (notification.type !== EXCHANGE_STATUS_CHANGED) return undefined;
  const parsed = exchangeStatusChangedPayloadSchema.safeParse(notification.payload);
  if (!parsed.success || parsed.data.toStatus !== 'FINISHED') return undefined;
  try {
    const exchange = await load(notification.userId, parsed.data.exchangeId);
    if (exchange.status !== 'FINISHED') return undefined;
    return renderExchangeCard(exchange, { demo });
  } catch (error) {
    if (error instanceof ExchangeNotFoundError) return undefined;
    throw error;
  }
}
