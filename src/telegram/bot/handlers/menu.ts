import type { BotContext, BotDependencies } from '../context.js';
import { clearCurrencyCommands } from '../currency-commands.js';
import { DEMO_BANNER, escapeHtml } from '../format.js';
import { backToMenuKeyboard, mainMenuKeyboard } from '../keyboards.js';
import { reply, show } from '../ui.js';

export function createMenuHandlers(deps: BotDependencies) {
  const demo = deps.demo !== undefined;

  function menuText(greeting?: string): string {
    const lines = [];
    if (demo) lines.push(DEMO_BANNER, '');
    if (greeting) lines.push(greeting, '');
    lines.push('<b>Обмен криптовалют</b>', 'Выберите действие:');
    return lines.join('\n');
  }

  return {
    /** Команда /start: приветствие и главное меню. */
    async start(ctx: BotContext): Promise<void> {
      ctx.session.flow = undefined;
      await clearCurrencyCommands(ctx, deps.logger);
      const name = ctx.appUser.firstName;
      const greeting = name ? `Здравствуйте, ${escapeHtml(name)}!` : 'Здравствуйте!';
      await reply(ctx, menuText(greeting), mainMenuKeyboard());
    },

    /** Главное меню; сбрасывает незавершённый диалог. */
    async menu(ctx: BotContext): Promise<void> {
      ctx.session.flow = undefined;
      await clearCurrencyCommands(ctx, deps.logger);
      await show(ctx, menuText(), mainMenuKeyboard());
    },

    async help(ctx: BotContext): Promise<void> {
      const lines = [];
      if (demo) lines.push(DEMO_BANNER, '');
      lines.push(
        '<b>Как это работает</b>',
        '1. Выберите валюты, тип курса и сумму.',
        '2. Укажите адрес, на который должны прийти средства.',
        '3. Проверьте котировку и подтвердите обмен.',
        '4. Отправьте средства на выданный адрес. Мы сообщим о каждом изменении статуса.',
        '',
        'Сервис некостодиальный: мы не храним ваши средства, ключи и seed-фразы и никогда не просим их.',
        '',
        'Команды: /start, /menu, /exchanges, /help',
      );
      await show(ctx, lines.join('\n'), backToMenuKeyboard());
    },

    /** Подсказка на сообщение, которое бот сейчас не ждёт. */
    async hint(ctx: BotContext): Promise<void> {
      await reply(ctx, 'Не понял сообщение. Воспользуйтесь меню:', mainMenuKeyboard());
    },
  };
}
