/**
 * Доменная запись пользователя. Не зависит от Prisma.
 * Внутренний идентификатор — UUID; Telegram ID хранится отдельно.
 */
export interface UserRecord {
  readonly id: string;
  readonly telegramId: bigint;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly languageCode: string | null;
  /** Когда Telegram сообщил, что пользователь заблокировал бота. NULL — бот доступен. */
  readonly botBlockedAt: Date | null;
}

/** Данные профиля, которые сообщает Telegram. */
export interface TelegramProfile {
  readonly telegramId: bigint;
  readonly username: string | null;
  readonly firstName: string | null;
  readonly languageCode: string | null;
}
