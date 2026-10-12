/**
 * grammY-адаптер порта NotificationSender.
 *
 * Переводит ошибки Telegram в NotificationSendError, по которому NotificationService
 * решает судьбу уведомления:
 *  - 403 (бот заблокирован, пользователь удалён)  → BOT_BLOCKED;
 *  - 429 (flood control)                           → TRANSIENT с retry_after;
 *  - 400 (chat not found и прочие неверные запросы) → PERMANENT: повтор ничего не изменит;
 *  - сеть, таймаут, 5xx, 401/404 и всё остальное    → TRANSIENT.
 *
 * Тексты исключений формируются здесь и не содержат ни токена, ни payload запроса.
 */
import { GrammyError, HttpError, type Api } from 'grammy';
import {
  NotificationSendError,
  type NotificationSender,
  type OutgoingMessage,
  type SendOptions,
} from '../../application/notifications/notification-sender.js';

export type TelegramSendApi = Pick<Api, 'sendMessage'>;

type GrammySignal = Parameters<Api['sendMessage']>[3];

const MAX_RETRY_AFTER_SECONDS = 3600;

function describe(error: GrammyError): string {
  // description задаёт сам Telegram (например, "Forbidden: bot was blocked by the user").
  return error.description.slice(0, 200);
}

/** Преобразует любую ошибку отправки в NotificationSendError. */
export function mapTelegramError(error: unknown): NotificationSendError {
  if (error instanceof NotificationSendError) return error;

  if (error instanceof GrammyError) {
    const code = `telegram_${String(error.error_code)}`;
    switch (error.error_code) {
      case 403:
        return new NotificationSendError('BOT_BLOCKED', code, describe(error));
      case 429: {
        const seconds = Math.min(error.parameters.retry_after ?? 1, MAX_RETRY_AFTER_SECONDS);
        return new NotificationSendError('TRANSIENT', code, describe(error), seconds * 1000);
      }
      case 400:
        return new NotificationSendError('PERMANENT', code, describe(error));
      default:
        return new NotificationSendError('TRANSIENT', code, describe(error));
    }
  }

  if (error instanceof HttpError) {
    // Исходная ошибка fetch может содержать URL запроса, а в нём токен: не пробрасываем её.
    return new NotificationSendError('TRANSIENT', 'telegram_network', 'Network error');
  }

  if (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) {
    return new NotificationSendError('TRANSIENT', 'telegram_timeout', 'Send timed out');
  }

  return new NotificationSendError('TRANSIENT', 'telegram_unknown', 'Unexpected send error');
}

export class TelegramNotificationSender implements NotificationSender {
  constructor(private readonly api: TelegramSendApi) {}

  async send(message: OutgoingMessage, options: SendOptions): Promise<void> {
    // Идентификаторы личных чатов Telegram помещаются в безопасный диапазон number.
    const chatId = Number(message.chatId);
    if (!Number.isSafeInteger(chatId)) {
      throw new NotificationSendError('PERMANENT', 'invalid_chat_id', 'Chat id is out of range');
    }

    try {
      await this.api.sendMessage(
        chatId,
        message.text,
        {
          link_preview_options: { is_disabled: true },
          ...(message.html ? { parse_mode: 'HTML' as const } : {}),
        },
        // grammY типизирует сигнал пакетом abort-controller; в рантайме это обычный AbortSignal.
        options.signal as GrammySignal,
      );
    } catch (error) {
      throw mapTelegramError(error);
    }
  }
}
