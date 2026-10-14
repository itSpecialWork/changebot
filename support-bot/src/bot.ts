/**
 * Админ-бот поддержки. До пароля текст считается паролем, после — ID заявки или @username.
 * Сообщения в лог не пишутся: в них пароль, адреса и суммы.
 */
import { Bot, type Context } from 'grammy';
import { renderSupportCard, renderSupportList } from './format.js';
import { findSupportExchange, type SupportLookup } from './lookup.js';
import type { Logger } from './logger.js';
import { passwordMatches } from './password.js';

function errorForLog(error: unknown): { name: string; code?: string } {
  const name = error instanceof Error ? error.name : 'Error';
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
  ) {
    return { name, code: error.code };
  }
  return { name };
}

const SESSION_TTL_MS = 30 * 60_000;
const LOCK_MS = 15 * 60_000;
const MAX_FAILURES = 5;

const ASK_PASSWORD = 'Введите пароль.';
const WRONG_PASSWORD = 'Неверный пароль.';
const ASK_ID = 'Пришлите ID из квитанции, @username или Telegram ID.';
const SESSION_EXPIRED = 'Сессия истекла. Введите пароль.';
const SESSION_CLOSED = 'Сессия закрыта. Введите пароль.';
const NOT_FOUND = 'Заявка не найдена.';
const USER_NOT_FOUND = 'Пользователь не найден.';
const INVALID_USERNAME = 'Имя Telegram пишется как @username, от 5 символов.';
const NO_EXCHANGES = 'Заявок у этого пользователя нет.';
const AMBIGUOUS = 'Уточните полный ID из квитанции.';
const LOOKUP_FAILED = 'Не удалось открыть заявку. Попробуйте ещё раз.';

interface AdminSession {
  failures: number;
  lockedUntilMs: number | null;
  authenticatedUntilMs: number | null;
}

export interface CreateSupportBotOptions {
  readonly token: string;
  readonly password: string;
  readonly lookup: SupportLookup;
  readonly logger: Logger;
  readonly now?: () => number;
}

export function createSupportBot(options: CreateSupportBotOptions): Bot {
  const bot = new Bot(options.token);
  const now = options.now ?? Date.now;
  const sessions = new Map<number, AdminSession>();

  function sessionFor(userId: number): AdminSession {
    const existing = sessions.get(userId);
    if (existing) return existing;
    const created: AdminSession = { failures: 0, lockedUntilMs: null, authenticatedUntilMs: null };
    sessions.set(userId, created);
    return created;
  }

  function locked(session: AdminSession, at: number): boolean {
    return session.lockedUntilMs !== null && at < session.lockedUntilMs;
  }

  function authenticated(session: AdminSession, at: number): boolean {
    return session.authenticatedUntilMs !== null && at < session.authenticatedUntilMs;
  }

  async function send(ctx: Context, text: string): Promise<void> {
    await ctx.reply(text, { parse_mode: 'HTML' });
  }

  function begin(ctx: Context): AdminSession | undefined {
    if (ctx.chat?.type !== 'private' || ctx.from === undefined || ctx.from.is_bot) return undefined;
    const session = sessionFor(ctx.from.id);
    if (locked(session, now())) return undefined;
    if (session.lockedUntilMs !== null) {
      session.lockedUntilMs = null;
      session.failures = 0;
    }
    return session;
  }

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type !== 'private' || ctx.from === undefined || ctx.from.is_bot) return;
    await next();
  });

  bot.command('start', async (ctx) => {
    const session = begin(ctx);
    if (session === undefined) return;
    const at = now();
    if (authenticated(session, at)) {
      await send(ctx, ASK_ID);
      return;
    }
    if (session.authenticatedUntilMs !== null) {
      session.authenticatedUntilMs = null;
      await send(ctx, SESSION_EXPIRED);
      return;
    }
    await send(ctx, ASK_PASSWORD);
  });

  bot.command('logout', async (ctx) => {
    const session = begin(ctx);
    if (session === undefined) return;
    session.authenticatedUntilMs = null;
    await send(ctx, SESSION_CLOSED);
  });

  bot.on('message:text', async (ctx) => {
    const session = begin(ctx);
    if (session === undefined) return;
    const text = ctx.message.text.trim();
    if (text.length === 0) return;
    const at = now();

    if (session.authenticatedUntilMs !== null && !authenticated(session, at)) {
      session.authenticatedUntilMs = null;
      await send(ctx, SESSION_EXPIRED);
      return;
    }

    if (text.startsWith('/')) {
      await send(ctx, authenticated(session, at) ? ASK_ID : ASK_PASSWORD);
      return;
    }

    if (!authenticated(session, at)) {
      if (!passwordMatches(text, options.password)) {
        session.failures += 1;
        if (session.failures >= MAX_FAILURES) {
          session.lockedUntilMs = at + LOCK_MS;
          session.authenticatedUntilMs = null;
          return;
        }
        await send(ctx, WRONG_PASSWORD);
        return;
      }
      session.failures = 0;
      session.lockedUntilMs = null;
      session.authenticatedUntilMs = at + SESSION_TTL_MS;
      await send(ctx, ASK_ID);
      return;
    }

    try {
      const outcome = await findSupportExchange(options.lookup, text);
      if (outcome.kind === 'missing') {
        await send(ctx, NOT_FOUND);
        return;
      }
      if (outcome.kind === 'ambiguous') {
        await send(ctx, AMBIGUOUS);
        return;
      }
      if (outcome.kind === 'invalid-username') {
        await send(ctx, INVALID_USERNAME);
        return;
      }
      if (outcome.kind === 'user-missing') {
        await send(ctx, USER_NOT_FOUND);
        return;
      }
      if (outcome.kind === 'empty') {
        await send(ctx, NO_EXCHANGES);
        return;
      }
      if (outcome.kind === 'list') {
        await send(ctx, renderSupportList(outcome.username, outcome.exchanges, outcome.truncated));
        return;
      }
      await send(ctx, renderSupportCard(outcome.exchange));
    } catch (error) {
      options.logger.error(errorForLog(error), 'Support lookup failed');
      await send(ctx, LOOKUP_FAILED);
    }
  });

  bot.catch((error) => {
    options.logger.error(errorForLog(error), 'Support bot update failed');
  });

  return bot;
}
