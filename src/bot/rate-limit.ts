/**
 * Ограничение частоты обновлений от одного пользователя (фиксированное окно).
 * Защищает от шквала нажатий и спама; состояние хранится в памяти процесса.
 */
import type { MiddlewareFn } from 'grammy';
import type { BotContext } from './context.js';

export interface RateLimitOptions {
  /** Сколько обновлений допускается за окно. */
  readonly limit: number;
  readonly windowMs: number;
  readonly now?: () => number;
}

interface Bucket {
  windowStart: number;
  count: number;
}

const CLEANUP_THRESHOLD = 1000;

export function createRateLimiter(options: RateLimitOptions): MiddlewareFn<BotContext> {
  const now = options.now ?? (() => Date.now());
  const buckets = new Map<number, Bucket>();

  return async (ctx, next) => {
    const userId = ctx.from?.id;
    if (userId === undefined) {
      await next();
      return;
    }

    const time = now();
    if (buckets.size > CLEANUP_THRESHOLD) {
      for (const [id, bucket] of buckets) {
        if (time - bucket.windowStart >= options.windowMs) buckets.delete(id);
      }
    }

    let bucket = buckets.get(userId);
    if (!bucket || time - bucket.windowStart >= options.windowMs) {
      bucket = { windowStart: time, count: 0 };
      buckets.set(userId, bucket);
    }
    bucket.count += 1;

    if (bucket.count <= options.limit) {
      await next();
      return;
    }
    // Превышение: сообщение молча отбрасывается, на кнопку отвечаем, чтобы не крутился индикатор.
    if (ctx.callbackQuery) {
      await ctx.answerCallbackQuery({ text: 'Слишком часто. Подождите немного.' }).catch(() => {
        // Ответ на callback необязателен: ошибка Telegram здесь не важна.
      });
    }
  };
}
