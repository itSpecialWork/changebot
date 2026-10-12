import { GrammyError, type InlineKeyboard } from 'grammy';
import type { BotContext } from './context.js';

function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes('message is not modified');
}

/**
 * Показывает экран: для нажатия на кнопку редактирует сообщение с кнопкой,
 * иначе (или если редактировать нельзя) отправляет новое сообщение.
 * `forceNew` всегда шлёт новое сообщение под уже написанным.
 */
export async function show(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
  replaceMessageId?: number,
  forceNew = false,
): Promise<number | undefined> {
  const other = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  } as const;

  const chatId = ctx.chat?.id;
  if (!forceNew && replaceMessageId !== undefined && chatId !== undefined && !ctx.callbackQuery) {
    try {
      await ctx.api.editMessageText(chatId, replaceMessageId, text, other);
      return replaceMessageId;
    } catch (error) {
      if (isMessageNotModified(error)) return replaceMessageId;
      // Сообщение удалено или слишком старое: отправим новое.
    }
  }

  if (!forceNew && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, other);
      return ctx.callbackQuery.message.message_id;
    } catch (error) {
      // Тот же текст нажатием «Обновить»: ничего делать не нужно.
      if (isMessageNotModified(error)) return ctx.callbackQuery.message.message_id;
      // Сообщение удалено или слишком старое: отправим новое.
    }
  }
  const sent = await ctx.reply(text, other);
  return sent.message_id;
}

/** Всегда отправляет новое сообщение (ответ на текст пользователя). */
export async function reply(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  await ctx.reply(text, {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
}
