/**
 * Сборка Telegram-бота (grammY): middleware и маршрутизация обновлений.
 *
 * Порядок middleware: только личные чаты → ограничение частоты → перехват ошибок →
 * сессия → пользователь (регистрация сбрасывает botBlockedAt) → ответ на callback → обработчики.
 * Обработчики тонкие: вся бизнес-логика находится в application-сервисах.
 */
import { Bot, GrammyError, HttpError, MemorySessionStorage, session } from 'grammy';
import { sanitizeErrorForStorage } from '../../application/notifications/sanitize-error.js';
import { parseCallbackData, type CallbackAction } from './callback-data.js';
import type { BotContext, BotDependencies, SessionData } from './context.js';
import { describeFailure } from './error-text.js';
import { createExchangeHandlers } from './handlers/exchanges.js';
import { createMenuHandlers } from './handlers/menu.js';
import { createNewExchangeHandlers } from './handlers/new-exchange.js';
import { mainMenuKeyboard } from './keyboards.js';
import { createRateLimiter, type RateLimitOptions } from './rate-limit.js';
import { show } from './ui.js';

const SESSION_TTL_MS = 30 * 60_000;
const DEFAULT_RATE_LIMIT: RateLimitOptions = { limit: 15, windowMs: 10_000 };

export interface CreateBotOptions extends BotDependencies {
  readonly token: string;
  readonly rateLimit?: RateLimitOptions;
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'Главное меню' },
  { command: 'exchanges', description: 'Мои обмены' },
  { command: 'help', description: 'Как это работает' },
] as const;

/**
 * Безопасное представление ошибки для логов. Ошибки grammY содержат payload запроса
 * (тексты сообщений, адреса) и контекст бота, поэтому целиком их логировать нельзя.
 */
export function describeErrorForLog(error: unknown): Record<string, unknown> {
  if (error instanceof GrammyError) {
    return {
      type: 'GrammyError',
      method: error.method,
      errorCode: error.error_code,
      description: error.description,
    };
  }
  if (error instanceof HttpError) return { type: 'HttpError' };
  if (error instanceof Error) {
    return { type: error.name, message: sanitizeErrorForStorage(error), stack: error.stack };
  }
  return { type: typeof error };
}

export function createBot(options: CreateBotOptions): Bot<BotContext> {
  const { logger } = options;
  const bot = new Bot<BotContext>(options.token);
  const menu = createMenuHandlers(options);
  const exchanges = createExchangeHandlers(options);
  const newExchange = createNewExchangeHandlers(options);

  async function route(ctx: BotContext, action: CallbackAction): Promise<void> {
    switch (action.kind) {
      case 'menu':
        return menu.menu(ctx);
      case 'help':
        return menu.help(ctx);
      case 'support':
        return menu.support(ctx);
      case 'agreements':
        return menu.agreements(ctx);
      case 'agreement':
        return menu.agreement(ctx, action.section);
      case 'new':
        return newExchange.start(ctx);
      case 'list':
        return exchanges.list(ctx);
      case 'resume_address':
        return newExchange.resumeAddress(ctx);
      case 'drop_address':
        await newExchange.dropAddressWait(ctx);
        return exchanges.list(ctx);
      case 'from':
        return newExchange.selectFrom(ctx, action.ticker, action.network);
      case 'to':
        return newExchange.selectTo(ctx, action.ticker, action.network);
      case 'ticker':
        return newExchange.selectTicker(ctx, action.side, action.ticker);
      case 'rate':
        return newExchange.selectRate(ctx);
      case 'transfer_basis':
        return newExchange.selectTransferBasis(ctx, action.basis);
      case 'skip_extra_id':
        return newExchange.skipExtraId(ctx);
      case 'open':
        return exchanges.open(ctx, action.exchangeId);
      case 'prepare':
        return exchanges.prepare(ctx, action.exchangeId);
      case 'confirm':
        return exchanges.confirm(ctx, action.exchangeId);
      case 'cancel':
        return exchanges.cancel(ctx, action.exchangeId);
      case 'demo':
        return exchanges.advanceDemo(ctx, action.exchangeId);
      case 'receipt':
        return exchanges.showReceipt(ctx, action.exchangeId, action.full);
      case 'currency_page':
        return newExchange.changePage(ctx, action.direction);
      case 'currency_back':
        return newExchange.backToTokens(ctx);
      case 'currency_catalog':
        return newExchange.setCatalog(ctx, action.catalog);
    }
  }

  // Только личные сообщения от людей.
  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || !ctx.from || ctx.from.is_bot) return;
    await next();
  });

  bot.use(createRateLimiter(options.rateLimit ?? DEFAULT_RATE_LIMIT));

  // Перехват ошибок обработчиков: пользователь получает понятное сообщение, а не тишину.
  bot.use(async (ctx, next) => {
    try {
      await next();
    } catch (error) {
      const friendly = describeFailure(error);
      if (friendly === undefined) {
        logger.error(
          { err: describeErrorForLog(error), updateId: ctx.update.update_id },
          'Unhandled error in bot handler',
        );
      }
      try {
        await show(
          ctx,
          friendly ?? 'Что-то пошло не так. Попробуйте ещё раз чуть позже.',
          mainMenuKeyboard(),
        );
      } catch (replyError) {
        logger.debug({ err: describeErrorForLog(replyError) }, 'Could not deliver error message');
      }
    }
  });

  bot.use(
    session<SessionData, BotContext>({
      initial: () => ({ flow: undefined }),
      storage: new MemorySessionStorage<SessionData>(SESSION_TTL_MS),
      getSessionKey: (ctx) => ctx.from?.id.toString(),
    }),
  );

  // Любое сообщение от пользователя регистрирует его и снимает отметку «бот заблокирован».
  bot.use(async (ctx, next) => {
    const from = ctx.from;
    if (!from) return;
    ctx.appUser = await options.users.registerFromTelegram({
      telegramId: BigInt(from.id),
      username: from.username ?? null,
      firstName: from.first_name,
      languageCode: from.language_code ?? null,
    });
    await next();
  });

  bot.command('start', (ctx) => menu.start(ctx));
  bot.command(['menu', 'cancel'], (ctx) => menu.menu(ctx));
  bot.command('exchanges', (ctx) => exchanges.list(ctx));
  bot.command('help', (ctx) => menu.help(ctx));

  bot.on('callback_query:data', async (ctx) => {
    // Сразу снимаем индикатор загрузки с кнопки; ошибка ответа не должна ломать обработку.
    await ctx.answerCallbackQuery().catch(() => {
      // Устаревший callback: Telegram отвечает ошибкой, действие всё равно можно выполнить.
    });
    const action = parseCallbackData(ctx.callbackQuery.data);
    if (!action) {
      await menu.menu(ctx);
      return;
    }
    await route(ctx, action);
  });

  bot.on('message:text', async (ctx) => {
    const handled = await newExchange.onText(ctx, ctx.message.text);
    if (!handled) await menu.hint(ctx);
  });

  bot.on('message', (ctx) => menu.hint(ctx));

  // Резервный обработчик: ошибки middleware выше уже перехвачены, сюда попадают только сбои самой цепочки.
  bot.catch((error) => {
    logger.error({ err: describeErrorForLog(error.error) }, 'Bot middleware failure');
  });

  return bot;
}
