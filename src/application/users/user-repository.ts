/**
 * Порт хранилища пользователей. Реализация (Prisma) лежит в src/database/repositories.
 */
import type { TelegramProfile, UserRecord } from '../../domain/users/user.js';

export interface UserRepository {
  /**
   * Находит пользователя по Telegram ID или создаёт его. Если профиль изменился
   * или пользователь был помечен как заблокировавший бота, запись обновляется
   * (botBlockedAt сбрасывается). Без изменений запись не пишется.
   * Безопасно при параллельных вызовах для одного Telegram ID.
   */
  upsertFromTelegram(profile: TelegramProfile): Promise<UserRecord>;
}
