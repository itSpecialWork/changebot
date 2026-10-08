/**
 * Перевод ошибок application-слоя в понятные пользователю сообщения.
 * Технические детали (тексты исключений, коды провайдера) пользователю не показываются.
 */
import {
  ExchangeNotCancellableError,
  ExchangeNotFoundError,
  ExchangeStatusConflictError,
  IdempotencyKeyReuseError,
  InvalidExchangeInputError,
  QuoteExpiredError,
} from '../../application/exchanges/errors.js';
import {
  ExchangeProviderError,
  type ExchangeProviderErrorCode,
} from '../../domain/exchanges/exchange-provider.js';

const PROVIDER_MESSAGES: Readonly<Record<ExchangeProviderErrorCode, string>> = {
  UNAVAILABLE: 'Сервис обмена временно недоступен. Попробуйте ещё раз через минуту.',
  INVALID_REQUEST: 'Провайдер отклонил параметры обмена. Проверьте данные и попробуйте снова.',
  PAIR_NOT_SUPPORTED: 'Эта пара валют сейчас недоступна. Выберите другую.',
  AMOUNT_OUT_OF_RANGE: 'Сумма вне допустимого диапазона для этой пары.',
  QUOTE_EXPIRED: 'Котировка устарела. Начните обмен заново.',
  NOT_FOUND: 'Обмен не найден у провайдера.',
};

/** Текст для пользователя или undefined, если ошибка непредвиденная (её нужно залогировать). */
export function describeFailure(error: unknown): string | undefined {
  if (error instanceof ExchangeProviderError) return PROVIDER_MESSAGES[error.code];
  if (error instanceof InvalidExchangeInputError) return 'Некорректные данные обмена.';
  if (error instanceof ExchangeNotFoundError) return 'Обмен не найден.';
  if (error instanceof ExchangeStatusConflictError) {
    return 'Состояние обмена уже изменилось. Откройте его заново.';
  }
  if (error instanceof ExchangeNotCancellableError) return 'Этот обмен уже нельзя отменить.';
  if (error instanceof QuoteExpiredError) return 'Котировка истекла. Начните новый обмен.';
  if (error instanceof IdempotencyKeyReuseError) return 'Начните новый обмен.';
  return undefined;
}
