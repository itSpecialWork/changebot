/**
 * Экспоненциальная задержка перед повторной проверкой после неудачи.
 * failureCount — число неудач подряд, включая текущую (>= 1).
 * Результат ограничен сверху, поэтому переполнения не бывает.
 */
export function computeBackoffDelayMs(
  failureCount: number,
  baseDelayMs: number,
  maxDelayMs: number,
): number {
  const exponent = Math.min(Math.max(failureCount - 1, 0), 30);
  return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
}
