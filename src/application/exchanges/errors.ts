import type { ExchangeStatus } from '../../domain/exchanges/status-transitions.js';

/** Обмен не найден или принадлежит другому пользователю (различие намеренно скрыто). */
export class ExchangeNotFoundError extends Error {
  constructor(public readonly exchangeId: string) {
    super('Exchange not found');
    this.name = 'ExchangeNotFoundError';
  }
}

/**
 * Статус обмена уже не тот, который ожидался. Типичные причины: повторное нажатие
 * кнопки, параллельная работа worker, повторная доставка события.
 */
export class ExchangeStatusConflictError extends Error {
  constructor(
    public readonly exchangeId: string,
    public readonly expected: ExchangeStatus,
    public readonly actual: ExchangeStatus,
  ) {
    super(`Exchange status conflict: expected ${expected}, actual ${actual}`);
    this.name = 'ExchangeStatusConflictError';
  }
}

export class QuoteExpiredError extends Error {
  constructor(public readonly exchangeId: string) {
    super('Quote has expired');
    this.name = 'QuoteExpiredError';
  }
}

/** Один и тот же ключ идемпотентности использован с другими параметрами обмена. */
export class IdempotencyKeyReuseError extends Error {
  constructor() {
    super('Idempotency key was already used with different parameters');
    this.name = 'IdempotencyKeyReuseError';
  }
}

/** Входные данные не прошли проверку на уровне приложения. */
export class InvalidExchangeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidExchangeInputError';
  }
}

/** Статус обмена нельзя сверять с провайдером (нет обмена у провайдера или он завершён). */
export class ExchangeNotSyncableError extends Error {
  constructor(
    public readonly exchangeId: string,
    public readonly status: ExchangeStatus,
  ) {
    super(`Exchange in status ${status} cannot be synced with provider`);
    this.name = 'ExchangeNotSyncableError';
  }
}
