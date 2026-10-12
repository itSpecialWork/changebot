import { GrammyError, HttpError } from 'grammy';
import { describe, expect, it, vi } from 'vitest';
import { NotificationSendError } from '../../../src/application/notifications/notification-sender.js';
import {
  mapTelegramError,
  TelegramNotificationSender,
} from '../../../src/telegram/notifications/telegram-notification-sender.js';

const TOKEN = '1234567890:AAExampleTokenForTestsOnly_0123456789abc';

function telegramError(
  errorCode: number,
  description: string,
  parameters: { retry_after?: number } = {},
): GrammyError {
  return new GrammyError(
    'Call to sendMessage failed!',
    { ok: false, error_code: errorCode, description, parameters },
    'sendMessage',
    { chat_id: 1, text: 'секретный адрес bc1qexample' },
  );
}

describe('mapTelegramError', () => {
  it('403 → BOT_BLOCKED', () => {
    const mapped = mapTelegramError(telegramError(403, 'Forbidden: bot was blocked by the user'));

    expect(mapped).toBeInstanceOf(NotificationSendError);
    expect(mapped.kind).toBe('BOT_BLOCKED');
    expect(mapped.code).toBe('telegram_403');
  });

  it('429 → TRANSIENT с retry_after в миллисекундах', () => {
    const mapped = mapTelegramError(
      telegramError(429, 'Too Many Requests: retry after 7', { retry_after: 7 }),
    );

    expect(mapped.kind).toBe('TRANSIENT');
    expect(mapped.retryAfterMs).toBe(7000);
  });

  it('429 ограничивает слишком большой retry_after', () => {
    const mapped = mapTelegramError(
      telegramError(429, 'Too Many Requests', { retry_after: 10 ** 7 }),
    );

    expect(mapped.retryAfterMs).toBe(3_600_000);
  });

  it('400 chat not found → PERMANENT', () => {
    const mapped = mapTelegramError(telegramError(400, 'Bad Request: chat not found'));

    expect(mapped.kind).toBe('PERMANENT');
    expect(mapped.code).toBe('telegram_400');
  });

  it.each([401, 404, 500, 502])('%i → TRANSIENT', (code) => {
    expect(mapTelegramError(telegramError(code, 'Some error')).kind).toBe('TRANSIENT');
  });

  it('сетевая ошибка → TRANSIENT, исходное сообщение с токеном не пробрасывается', () => {
    const mapped = mapTelegramError(
      new HttpError(
        'Network request failed',
        new Error(`fetch https://api.telegram.org/bot${TOKEN}/sendMessage`),
      ),
    );

    expect(mapped.kind).toBe('TRANSIENT');
    expect(mapped.message).not.toContain(TOKEN);
  });

  it('таймаут и неизвестные ошибки → TRANSIENT', () => {
    const timeout = new Error('aborted');
    timeout.name = 'TimeoutError';

    expect(mapTelegramError(timeout).code).toBe('telegram_timeout');
    expect(mapTelegramError(new Error('boom')).kind).toBe('TRANSIENT');
    expect(mapTelegramError('string').kind).toBe('TRANSIENT');
  });

  it('не содержит payload запроса (текст сообщения, адреса)', () => {
    const mapped = mapTelegramError(telegramError(400, 'Bad Request: message is too long'));

    expect(JSON.stringify(mapped)).not.toContain('bc1qexample');
    expect(mapped.message).not.toContain('bc1qexample');
  });
});

describe('TelegramNotificationSender', () => {
  const signal = new AbortController().signal;

  it('отправляет обычный текст в нужный чат', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = new TelegramNotificationSender({ sendMessage });

    await sender.send({ chatId: 123456789n, text: 'Привет' }, { signal });

    expect(sendMessage).toHaveBeenCalledOnce();
    const [chatId, text, other, passedSignal] = sendMessage.mock.calls[0] as unknown[];
    expect(chatId).toBe(123456789);
    expect(text).toBe('Привет');
    expect(other).not.toHaveProperty('parse_mode');
    expect(passedSignal).toBe(signal);
  });

  it('квитанцию отправляет с HTML-разметкой', async () => {
    const sendMessage = vi.fn().mockResolvedValue({});
    const sender = new TelegramNotificationSender({ sendMessage });

    await sender.send({ chatId: 1n, text: '<b>Квитанция</b>', html: true }, { signal });

    const other = sendMessage.mock.calls[0]?.[2] as { parse_mode?: string };
    expect(other.parse_mode).toBe('HTML');
  });

  it('оборачивает ошибки Telegram в NotificationSendError', async () => {
    const sendMessage = vi.fn().mockRejectedValue(telegramError(403, 'Forbidden: bot was blocked'));
    const sender = new TelegramNotificationSender({ sendMessage });

    await expect(sender.send({ chatId: 1n, text: 'x' }, { signal })).rejects.toMatchObject({
      name: 'NotificationSendError',
      kind: 'BOT_BLOCKED',
    });
  });

  it('chatId вне безопасного диапазона → PERMANENT без обращения к Telegram', async () => {
    const sendMessage = vi.fn();
    const sender = new TelegramNotificationSender({ sendMessage });

    await expect(sender.send({ chatId: 2n ** 60n, text: 'x' }, { signal })).rejects.toMatchObject({
      kind: 'PERMANENT',
    });
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
