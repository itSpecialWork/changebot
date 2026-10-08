/**
 * Порт отправки сообщения пользователю. Telegram (grammY) подключается
 * отдельным адаптером; application-слой о нём ничего не знает.
 */

export interface OutgoingMessage {
  /** Идентификатор чата (для личных сообщений совпадает с Telegram ID пользователя). */
  readonly chatId: bigint;
  /** Обычный текст без разметки. */
  readonly text: string;
}

export interface SendOptions {
  readonly signal: AbortSignal;
}

export interface NotificationSender {
  /**
   * Отправляет сообщение. Ошибки доставки адаптер оборачивает в NotificationSendError;
   * любая другая ошибка трактуется как временная.
   */
  send(message: OutgoingMessage, options: SendOptions): Promise<void>;
}

/**
 *  - TRANSIENT: временный сбой (сеть, 5xx, rate limit), повтор имеет смысл;
 *  - PERMANENT: повтор не поможет (например, чат не найден);
 *  - BOT_BLOCKED: пользователь заблокировал бота.
 */
export type NotificationSendErrorKind = 'TRANSIENT' | 'PERMANENT' | 'BOT_BLOCKED';

export class NotificationSendError extends Error {
  constructor(
    public readonly kind: NotificationSendErrorKind,
    /** Короткий машинный код, например telegram_429. */
    public readonly code: string,
    message: string,
    /** Подсказка провайдера, через сколько можно повторить (Telegram retry_after). */
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'NotificationSendError';
  }
}
