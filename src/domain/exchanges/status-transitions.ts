/**
 * Внутренние статусы обмена и допустимые переходы между ними.
 *
 * Это чистый доменный модуль: он не зависит от Prisma, БД и провайдеров.
 * Список статусов должен совпадать с enum `ExchangeStatus` в prisma/schema.prisma
 * (это проверяет tests/domain/exchange-status-sync.test.ts).
 *
 * Переходы выполняются только через ExchangeService, который обязан вызывать
 * `assertTransition` и записывать каждый переход в ExchangeStatusHistory.
 */

export const EXCHANGE_STATUSES = [
  'DRAFT',
  'QUOTED',
  'AWAITING_CONFIRMATION',
  'CREATING',
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'FINISHED',
  'FAILED',
  'REFUNDED',
  'VERIFYING',
  'EXPIRED',
] as const;

export type ExchangeStatus = (typeof EXCHANGE_STATUSES)[number];

/** Терминальные статусы: исходящих переходов нет, worker обмен больше не проверяет. */
export const TERMINAL_EXCHANGE_STATUSES = ['FINISHED', 'FAILED', 'REFUNDED', 'EXPIRED'] as const;

/**
 * Матрица допустимых переходов.
 *
 * - Пропуск промежуточных статусов вперёд допустим: polling мог не увидеть их
 *   (например, WAITING_DEPOSIT → FINISHED). Пропуск фиксируется в истории.
 * - Возвраты назад и самопереходы запрещены.
 * - В EXPIRED своими часами уходит только WAITING_DEPOSIT: окно депозита вышло,
 *   провайдер всё ещё ждёт оплату и хеша депозита нет. Ответ провайдера `expired`
 *   закрывает и более поздние живые статусы. Пока депозит уже виден, часы обмен не закрывают.
 */
const ALLOWED_TRANSITIONS: Readonly<Record<ExchangeStatus, readonly ExchangeStatus[]>> = {
  DRAFT: ['QUOTED', 'EXPIRED'],
  QUOTED: ['AWAITING_CONFIRMATION', 'EXPIRED'],
  AWAITING_CONFIRMATION: ['CREATING', 'EXPIRED'],
  CREATING: ['WAITING_DEPOSIT', 'FAILED'],
  WAITING_DEPOSIT: [
    'CONFIRMING',
    'EXCHANGING',
    'SENDING',
    'FINISHED',
    'VERIFYING',
    'FAILED',
    'REFUNDED',
    'EXPIRED',
  ],
  CONFIRMING: ['EXCHANGING', 'SENDING', 'FINISHED', 'VERIFYING', 'FAILED', 'REFUNDED', 'EXPIRED'],
  EXCHANGING: ['SENDING', 'FINISHED', 'VERIFYING', 'FAILED', 'REFUNDED', 'EXPIRED'],
  VERIFYING: ['CONFIRMING', 'EXCHANGING', 'SENDING', 'FINISHED', 'FAILED', 'REFUNDED', 'EXPIRED'],
  SENDING: ['FINISHED', 'FAILED', 'EXPIRED'],
  FINISHED: [],
  FAILED: [],
  REFUNDED: [],
  EXPIRED: [],
};

export class InvalidExchangeStatusTransitionError extends Error {
  constructor(
    public readonly from: ExchangeStatus,
    public readonly to: ExchangeStatus,
  ) {
    super(`Invalid exchange status transition: ${from} -> ${to}`);
    this.name = 'InvalidExchangeStatusTransitionError';
  }
}

export function isTerminalStatus(status: ExchangeStatus): boolean {
  return (TERMINAL_EXCHANGE_STATUSES as readonly ExchangeStatus[]).includes(status);
}

export function getAllowedTransitions(from: ExchangeStatus): readonly ExchangeStatus[] {
  return ALLOWED_TRANSITIONS[from];
}

export function canTransition(from: ExchangeStatus, to: ExchangeStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: ExchangeStatus, to: ExchangeStatus): void {
  if (!canTransition(from, to)) {
    throw new InvalidExchangeStatusTransitionError(from, to);
  }
}
