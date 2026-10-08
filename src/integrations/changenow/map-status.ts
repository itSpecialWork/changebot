/**
 * Сырые статусы ChangeNOW API v2 → внутренние статусы провайдера.
 * Неизвестный статус не отбрасывается, а уходит на проверку.
 */
import type { ProviderExchangeStatusName } from '../../domain/exchanges/exchange-provider.js';

const RAW_STATUS_TO_INTERNAL: Readonly<Record<string, ProviderExchangeStatusName>> = {
  new: 'WAITING_DEPOSIT',
  waiting: 'WAITING_DEPOSIT',
  confirming: 'CONFIRMING',
  exchanging: 'EXCHANGING',
  sending: 'SENDING',
  finished: 'FINISHED',
  failed: 'FAILED',
  refunded: 'REFUNDED',
  verifying: 'VERIFYING',
};

export function mapChangeNowStatus(raw: string): ProviderExchangeStatusName {
  return RAW_STATUS_TO_INTERNAL[raw] ?? 'VERIFYING';
}
