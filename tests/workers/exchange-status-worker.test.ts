import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PollSummary } from '../../src/application/exchanges/exchange-service.js';
import { createLogger } from '../../src/observability/logger.js';
import { ExchangeStatusWorker } from '../../src/workers/exchange-status-worker.js';

const EMPTY: PollSummary = { claimed: 0, transitioned: 0, unchanged: 0, deferred: 0, errors: 0 };
const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });

describe('ExchangeStatusWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWorker(pollDueExchanges: (limit: number) => Promise<PollSummary>) {
    const poll = vi.fn(pollDueExchanges);
    const worker = new ExchangeStatusWorker({
      poller: { pollDueExchanges: poll },
      logger,
      intervalMs: 1000,
      batchSize: 5,
    });
    return { worker, poll };
  }

  it('запускает проход сразу, затем с заданным интервалом', async () => {
    const { worker, poll } = createWorker(() => Promise.resolve(EMPTY));

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(poll).toHaveBeenCalledTimes(1);
    expect(poll).toHaveBeenCalledWith(5);

    await vi.advanceTimersByTimeAsync(999);
    expect(poll).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);

    await worker.stop();
  });

  it('при полном пакете не ждёт интервал', async () => {
    const { worker, poll } = createWorker(() => Promise.resolve({ ...EMPTY, claimed: 5 }));

    worker.start();
    // Меньше интервала (1000 мс): повторные проходы возможны только благодаря нулевой паузе.
    await vi.advanceTimersByTimeAsync(10);
    expect(poll.mock.calls.length).toBeGreaterThanOrEqual(2);

    await worker.stop();
  });

  it('переживает ошибку прохода и продолжает работу', async () => {
    let calls = 0;
    const { worker, poll } = createWorker(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(EMPTY);
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);

    await worker.stop();
  });

  it('не допускает перекрытия проходов', async () => {
    let release: (() => void) | undefined;
    const { worker, poll } = createWorker(
      () =>
        new Promise<PollSummary>((resolve) => {
          release = () => {
            resolve(EMPTY);
          };
        }),
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(poll).toHaveBeenCalledTimes(2);

    release?.();
    await worker.stop();
  });

  it('stop дожидается текущего прохода и больше не запускает новые', async () => {
    let release: (() => void) | undefined;
    let finished = false;
    const { worker, poll } = createWorker(
      () =>
        new Promise<PollSummary>((resolve) => {
          release = () => {
            finished = true;
            resolve(EMPTY);
          };
        }),
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(0);

    const stopping = worker.stop();
    release?.();
    await stopping;
    expect(finished).toBe(true);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(poll).toHaveBeenCalledTimes(1);
  });
});
