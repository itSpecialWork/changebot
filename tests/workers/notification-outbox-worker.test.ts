import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchSummary } from '../../src/application/notifications/notification-service.js';
import { createLogger } from '../../src/observability/logger.js';
import { NotificationOutboxWorker } from '../../src/workers/notification-outbox-worker.js';

const EMPTY: DispatchSummary = {
  requeued: 0,
  expired: 0,
  claimed: 0,
  sent: 0,
  retried: 0,
  failed: 0,
  lost: 0,
  errors: 0,
};
const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });

describe('NotificationOutboxWorker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function createWorker(dispatchDue: (limit: number) => Promise<DispatchSummary>) {
    const dispatch = vi.fn(dispatchDue);
    const worker = new NotificationOutboxWorker({
      dispatcher: { dispatchDue: dispatch },
      logger,
      intervalMs: 1000,
      batchSize: 5,
    });
    return { worker, dispatch };
  }

  it('запускает проход сразу, затем с заданным интервалом', async () => {
    const { worker, dispatch } = createWorker(() => Promise.resolve(EMPTY));

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(5);

    await vi.advanceTimersByTimeAsync(999);
    expect(dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(dispatch).toHaveBeenCalledTimes(2);

    await worker.stop();
  });

  it('при полном пакете не ждёт интервал', async () => {
    const { worker, dispatch } = createWorker(() => Promise.resolve({ ...EMPTY, claimed: 5 }));

    worker.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);

    await worker.stop();
  });

  it('переживает ошибку прохода и продолжает работу', async () => {
    let calls = 0;
    const { worker, dispatch } = createWorker(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('db down')) : Promise.resolve(EMPTY);
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(2);

    await worker.stop();
  });

  it('не допускает перекрытия проходов', async () => {
    let release: (() => void) | undefined;
    const { worker, dispatch } = createWorker(
      () =>
        new Promise<DispatchSummary>((resolve) => {
          release = () => {
            resolve(EMPTY);
          };
        }),
    );

    worker.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(dispatch).toHaveBeenCalledTimes(1);

    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(dispatch).toHaveBeenCalledTimes(2);

    release?.();
    await worker.stop();
  });

  it('stop дожидается текущего прохода и больше не запускает новые', async () => {
    let release: (() => void) | undefined;
    let finished = false;
    const { worker, dispatch } = createWorker(
      () =>
        new Promise<DispatchSummary>((resolve) => {
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
    expect(dispatch).toHaveBeenCalledTimes(1);
  });
});
