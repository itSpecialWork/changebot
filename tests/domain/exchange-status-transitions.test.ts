import { describe, expect, it } from 'vitest';
import {
  EXCHANGE_STATUSES,
  InvalidExchangeStatusTransitionError,
  TERMINAL_EXCHANGE_STATUSES,
  assertTransition,
  canTransition,
  getAllowedTransitions,
  isTerminalStatus,
  type ExchangeStatus,
} from '../../src/domain/exchanges/status-transitions.js';

/** Позиция в основной цепочке; побочные статусы (FAILED, REFUNDED, VERIFYING, EXPIRED) не входят. */
const MAIN_FLOW: readonly ExchangeStatus[] = [
  'DRAFT',
  'QUOTED',
  'AWAITING_CONFIRMATION',
  'CREATING',
  'WAITING_DEPOSIT',
  'CONFIRMING',
  'EXCHANGING',
  'SENDING',
  'FINISHED',
];

describe('ExchangeStatus transitions', () => {
  it('основной поток проходится шаг за шагом', () => {
    for (const [i, from] of MAIN_FLOW.entries()) {
      const to = MAIN_FLOW[i + 1];
      if (to === undefined) continue;
      expect(canTransition(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  it('терминальные статусы не имеют исходящих переходов', () => {
    for (const status of TERMINAL_EXCHANGE_STATUSES) {
      expect(isTerminalStatus(status)).toBe(true);
      expect(getAllowedTransitions(status)).toEqual([]);
    }
  });

  it('нетерминальные статусы имеют хотя бы один исходящий переход', () => {
    for (const status of EXCHANGE_STATUSES) {
      if (!isTerminalStatus(status)) {
        expect(getAllowedTransitions(status).length, status).toBeGreaterThan(0);
      }
    }
  });

  it('самопереходы запрещены', () => {
    for (const status of EXCHANGE_STATUSES) {
      expect(canTransition(status, status), status).toBe(false);
    }
  });

  it('возвраты назад по основной цепочке запрещены', () => {
    for (const [i, from] of MAIN_FLOW.entries()) {
      for (const to of MAIN_FLOW.slice(0, i)) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(false);
      }
    }
  });

  it('допускает пропуск промежуточных статусов вперёд после создания у провайдера', () => {
    expect(canTransition('WAITING_DEPOSIT', 'SENDING')).toBe(true);
    expect(canTransition('WAITING_DEPOSIT', 'FINISHED')).toBe(true);
    expect(canTransition('CONFIRMING', 'FINISHED')).toBe(true);
    expect(canTransition('EXCHANGING', 'FINISHED')).toBe(true);
  });

  it('не допускает пропуск стадий до создания у провайдера', () => {
    expect(canTransition('DRAFT', 'AWAITING_CONFIRMATION')).toBe(false);
    expect(canTransition('QUOTED', 'CREATING')).toBe(false);
    expect(canTransition('AWAITING_CONFIRMATION', 'WAITING_DEPOSIT')).toBe(false);
    expect(canTransition('CREATING', 'FINISHED')).toBe(false);
  });

  it('WAITING_DEPOSIT нельзя перевести в EXPIRED по собственному таймеру', () => {
    expect(canTransition('WAITING_DEPOSIT', 'EXPIRED')).toBe(false);
  });

  it('EXPIRED достижим только до создания обмена у провайдера', () => {
    const sources = EXCHANGE_STATUSES.filter((s) => canTransition(s, 'EXPIRED'));
    expect(sources).toEqual(['DRAFT', 'QUOTED', 'AWAITING_CONFIRMATION']);
  });

  it('CREATING может закончиться только депозитом или FAILED', () => {
    expect(getAllowedTransitions('CREATING')).toEqual(['WAITING_DEPOSIT', 'FAILED']);
  });

  it('VERIFYING возвращается в обработку, но не в ожидание депозита', () => {
    expect(canTransition('VERIFYING', 'EXCHANGING')).toBe(true);
    expect(canTransition('VERIFYING', 'WAITING_DEPOSIT')).toBe(false);
  });

  it('assertTransition бросает типизированную ошибку', () => {
    expect(() => {
      assertTransition('FINISHED', 'FAILED');
    }).toThrow(InvalidExchangeStatusTransitionError);

    try {
      assertTransition('FINISHED', 'FAILED');
    } catch (error) {
      expect(error).toMatchObject({ from: 'FINISHED', to: 'FAILED' });
    }

    expect(() => {
      assertTransition('DRAFT', 'QUOTED');
    }).not.toThrow();
  });
});
