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
        '1. Выберите монету и сеть отправки, затем монету и сеть получения. На шаге монеты меню «/» подсказывает варианты, например /btc или /usdt_trc20.',
        '2. Для обычного обмена введите сумму, которую отдаёте. Курс фиксированный, если пара его поддерживает, иначе плавающий. Для перевода той же монеты в той же сети укажите сумму, которую получит адресат, или сумму, которая есть у вас. Во втором случае к отправке будет не больше введённой. Та же монета в другой сети — обычный обмен.',
        '3. Укажите адрес получения.',
        '4. Проверьте данные и подтвердите.',
        '5. Отправьте средства на выданный адрес. Мы сообщим о каждом изменении статуса.',
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
