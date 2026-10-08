const MAX_ERROR_LENGTH = 200;

/** Токен Telegram-бота: `<числа>:<35 символов>`, в URL — после `/bot`. */
const BOT_TOKEN = /\b(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/gi;
/** Любые длинные «секретоподобные» последовательности. */
const LONG_SECRET = /[A-Za-z0-9_-]{40,}/g;

/**
 * Превращает ошибку в безопасную строку для NotificationOutbox.lastError:
 * маскирует токены, схлопывает пробелы и усекает. Результат никогда не пустой
 * (в БД стоит CHECK на непустое значение).
 */
export function sanitizeErrorForStorage(error: unknown): string {
  const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const cleaned = raw
    .replace(BOT_TOKEN, '[REDACTED]')
    .replace(LONG_SECRET, '[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned === '') return 'unknown_error';
  return cleaned.length > MAX_ERROR_LENGTH ? `${cleaned.slice(0, MAX_ERROR_LENGTH - 1)}…` : cleaned;
}
