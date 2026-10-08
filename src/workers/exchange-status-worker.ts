/**
 * Фоновый worker опроса статусов обменов.
 *
 * Отвечает только за расписание: запускает проходы по таймеру, не допускает
 * перекрытия проходов и корректно останавливается. Вся логика проверки находится
 * в application-слое (ExchangeService.pollDueExchanges).
 */
import type { PollSummary } from '../application/exchanges/exchange-service.js';
import type { Logger } from '../observability/logger.js';

export interface ExchangePoller {
  pollDueExchanges(limit: number): Promise<PollSummary>;
}

export interface ExchangeStatusWorkerOptions {
  readonly poller: ExchangePoller;
  readonly logger: Logger;
  /** Пауза между проходами, когда работы нет. */
  readonly intervalMs: number;
  /** Максимум обменов за один проход. */
  readonly batchSize: number;
}

export class ExchangeStatusWorker {
  private readonly poller: ExchangePoller;
  private readonly logger: Logger;
  private readonly intervalMs: number;
  private readonly batchSize: number;

  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private stopped = true;

  constructor(options: ExchangeStatusWorkerOptions) {
    this.poller = options.poller;
    this.logger = options.logger;
    this.intervalMs = options.intervalMs;
    this.batchSize = options.batchSize;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
    this.logger.info(
      { intervalMs: this.intervalMs, batchSize: this.batchSize },
      'Exchange status worker started',
    );
  }

  /** Останавливает расписание и дожидается завершения текущего прохода. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    await this.running;
    this.logger.info('Exchange status worker stopped');
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.running = this.tick().finally(() => {
        this.running = undefined;
      });
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let nextDelay = this.intervalMs;
    try {
      const summary = await this.poller.pollDueExchanges(this.batchSize);
      if (summary.claimed > 0) {
        this.logger.debug(summary, 'Exchange status poll finished');
      }
      // Полный пакет означает, что работа, возможно, ещё осталась: не ждём интервал.
      if (summary.claimed >= this.batchSize) nextDelay = 0;
    } catch (error) {
      // Сбой БД или другая системная ошибка: worker не падает, повторит по расписанию.
      this.logger.error({ err: error }, 'Exchange status poll failed');
    }
    this.schedule(nextDelay);
  }
}
