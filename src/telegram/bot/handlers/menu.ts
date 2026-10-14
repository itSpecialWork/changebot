import type { AgreementSection } from '../callback-data.js';
import type { BotContext, BotDependencies } from '../context.js';
import { clearCurrencyCommands } from '../currency-commands.js';
import { DEMO_BANNER, escapeHtml } from '../format.js';
import {
  agreementSectionKeyboard,
  agreementsKeyboard,
  backToMenuKeyboard,
  mainMenuKeyboard,
} from '../keyboards.js';
import { reply, show } from '../ui.js';

/**
 * Заглушки контактов. Заменить, когда появятся настоящие почта и Telegram.
 * В тексте только эти константы: адреса заявок сюда не подставляются.
 */
const SUPPORT_EMAIL = 'support@example.com';
const SUPPORT_TELEGRAM_URL = 'https://t.me/your_support';
const SUPPORT_TELEGRAM_LABEL = '@your_support';

/** Три коротких раздела вместо одной длинной оферты. Тексты совпадают с тем, что бот реально делает. */
function agreementLines(section: AgreementSection): readonly string[] {
  switch (section) {
    case 'use':
      return [
        '<b>Условия обмена</b>',
        'Сервис не хранит ваши монеты, ключи и seed-фразы и никогда их не просит.',
        '',
        'Вы сами отправляете средства на адрес из инструкции. Бот показывает курс, адрес и статус заявки.',
        '',
        'Перед подтверждением проверьте монету, сеть, сумму, адрес и memo. Ошибочный перевод вернуть нельзя.',
        '',
        'Курс фиксированный, если пара его поддерживает. Иначе курс плавающий, и сумма получения может немного отличаться.',
        '',
        'Перевод той же монеты в той же сети идёт без конвертации. Та же монета в другой сети — обычный обмен.',
      ];
    case 'risk':
      return [
        '<b>Риски</b>',
        'Сеть может подтверждать платёж дольше обычного. Статус в боте обновляется по мере продвижения заявки.',
        '',
        'Котировка действует ограниченное время. Если срок истёк, начните обмен заново: старые суммы уже не действуют.',
        '',
        'Отправляйте ровно указанную сумму. Если у депозита есть memo, его нельзя пропускать.',
        '',
        'Если заявка не удалась после отправки средств, откройте «Служба поддержки» и назовите ID из квитанции. Бот сам средства не хранит, поэтому возврат зависит от сети.',
      ];
    case 'data':
      return [
        '<b>Какие данные храним</b>',
        'Мы сохраняем Telegram ID, имя и историю заявок, чтобы показать статус и прислать уведомление.',
        '',
        'В карточке заявки остаются адрес, memo, сумма и статус — чтобы вы могли открыть её снова.',
        '',
        'Приватные ключи и seed-фразы мы не запрашиваем и не храним.',
        '',
        'Сообщение в поддержку вы отправляете сами на почту или в Telegram. Бот эту переписку не читает.',
      ];
  }
}

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
      await reply(ctx, menuText(greeting), mainMenuKeyboard(deps.widgetButton));
    },

    /** Главное меню; сбрасывает незавершённый диалог. */
    async menu(ctx: BotContext): Promise<void> {
      ctx.session.flow = undefined;
      await clearCurrencyCommands(ctx, deps.logger);
      await show(ctx, menuText(), mainMenuKeyboard(deps.widgetButton));
    },

    async support(ctx: BotContext): Promise<void> {
      const lines = [];
      if (demo) lines.push(DEMO_BANNER, '');
      lines.push(
        '<b>Служба поддержки</b>',
        'Если появились вопросы по заявке, напишите сюда. В сообщении укажите ID из карточки обмена — так мы быстрее найдём её.',
        '',
        `Почта: <a href="mailto:${SUPPORT_EMAIL}">${escapeHtml(SUPPORT_EMAIL)}</a>`,
        `Telegram: <a href="${SUPPORT_TELEGRAM_URL}">${escapeHtml(SUPPORT_TELEGRAM_LABEL)}</a>`,
      );
      await show(ctx, lines.join('\n'), backToMenuKeyboard());
    },

    async agreements(ctx: BotContext): Promise<void> {
      const lines = [];
      if (demo) lines.push(DEMO_BANNER, '');
      lines.push(
        '<b>Соглашения</b>',
        'Коротко о правилах обмена. Откройте раздел — каждый помещается на один экран.',
        'Это памятка, а не юридическая консультация: перед отправкой средств проверьте адрес, сеть и memo.',
      );
      await show(ctx, lines.join('\n'), agreementsKeyboard());
    },

    async agreement(ctx: BotContext, section: AgreementSection): Promise<void> {
      const lines = [];
      if (demo) lines.push(DEMO_BANNER, '');
      lines.push(...agreementLines(section));
      await show(ctx, lines.join('\n'), agreementSectionKeyboard());
    },

    async help(ctx: BotContext): Promise<void> {
      const lines = [];
      if (demo) lines.push(DEMO_BANNER, '');
      lines.push(
        '<b>Как это работает</b>',
        '1. Выберите монету и сеть отправки, затем монету и сеть получения. На шаге монеты меню «/» подсказывает варианты, например /btc или /usdt_trc20.',
        '2. Введите сумму, которую отдаёте. Это сумма отправки и для одинаковой монеты в одной сети. Курс фиксированный, если пара его поддерживает, иначе плавающий. Получение посчитает котировка.',
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
      await reply(
        ctx,
        'Не понял сообщение. Воспользуйтесь меню:',
        mainMenuKeyboard(deps.widgetButton),
      );
    },
  };
}
