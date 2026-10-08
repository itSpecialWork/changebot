/**
 * UserService: учёт пользователей Telegram.
 *
 * Любое входящее обновление от пользователя доказывает, что он может писать боту,
 * поэтому регистрация одновременно снимает отметку «бот заблокирован»
 * (иначе уведомления для такого пользователя остались бы отключёнными навсегда).
 */
import type { TelegramProfile, UserRecord } from '../../domain/users/user.js';
import type { UserRepository } from './user-repository.js';

export class UserService {
  constructor(private readonly repository: UserRepository) {}

  /** Регистрирует пользователя при первом обращении и обновляет профиль при следующих. */
  async registerFromTelegram(profile: TelegramProfile): Promise<UserRecord> {
    return this.repository.upsertFromTelegram(profile);
  }
}
