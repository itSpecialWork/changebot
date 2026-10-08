import { GrammyError, type InlineKeyboard } from 'grammy';
import type { BotContext } from './context.js';

function isMessageNotModified(error: unknown): boolean {
  return error instanceof GrammyError && error.description.includes('message is not modified');
}

/**
 * Показывает экран: для нажатия на кнопку редактирует сообщение с кнопкой,
 * иначе (или если редактировать нельзя) отправляет новое сообщение.
 */
export async function show(
  ctx: BotContext,
  text: string,
  keyboard?: InlineKeyboard,
): Promise<void> {
  const other = {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    ...(keyboard ? { reply_markup: keyboard } : {}),
  } as const;

  if (ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, other);
      return;
    } catch (error) {
      // Тот же текст нажатием «Обновить»: ничего делать не нужно.
      if (isMessageNotModified(error)) return;
      // Сообщение удалено или слишком старое: отправим новое.
    }
  }
  await ctx.reply(text, other);
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
