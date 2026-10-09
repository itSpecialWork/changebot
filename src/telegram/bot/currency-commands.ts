/**
 * Подсказки тикера в поле ввода — это меню команд Telegram.
 * Оно появляется при вводе «/», как у BotFather, и фильтруется по мере набора.
 * Обычный текст бот так подсказать не может: Telegram не даёт своего выпадающего списка.
 *
 * Список действует только в этом чате и только на шаге выбора валюты.
 * Команды /start, /exchanges, /help и /cancel остаются в меню.
 */
import type { ProviderCurrency } from '../../domain/exchanges/exchange-provider.js';
import type { Logger } from '../../observability/logger.js';
import type { BotContext } from './context.js';
import { POPULAR_PAIRS } from './keyboards.js';

const MAX_COMMANDS = 100;
const COMMAND_NAME = /^[a-z0-9_]{1,32}$/;

interface TelegramCommand {
  readonly command: string;
  readonly description: string;
}

/** Эти команды не отдаём монетам: ими пользуются вне выбора валюты. */
const KEPT_COMMANDS: readonly TelegramCommand[] = [
  { command: 'start', description: 'Главное меню' },
  { command: 'exchanges', description: 'Мои обмены' },
  { command: 'help', description: 'Как это работает' },
  { command: 'cancel', description: 'Отменить шаг' },
];

/**
 * Монеты, которые стоит видеть в «/», даже если их нет среди кнопок.
 * Сеть — код каталога. Если такой пары нет, команда не создаётся.
 */
const EXTRA_COMMAND_PAIRS: readonly {
  readonly ticker: string;
  readonly networks: readonly string[];
}[] = [
  { ticker: 'xlm', networks: ['xlm'] },
  { ticker: 'xmr', networks: ['xmr'] },
  { ticker: 'doge', networks: ['doge'] },
  { ticker: 'bnb', networks: ['bsc', 'bnb'] },
  { ticker: 'usdc', networks: ['eth', 'trx', 'sol'] },
  { ticker: 'ada', networks: ['ada'] },
  { ticker: 'dot', networks: ['dot'] },
  { ticker: 'link', networks: ['eth'] },
  { ticker: 'avax', networks: ['avax'] },
  { ticker: 'atom', networks: ['atom'] },
  { ticker: 'near', networks: ['near'] },
  { ticker: 'bch', networks: ['bch'] },
  { ticker: 'dai', networks: ['eth'] },
];

const NETWORK_SUFFIX: Readonly<Record<string, string>> = {
  trx: 'trc20',
  eth: 'erc20',
  bsc: 'bep20',
  bnb: 'bep20',
};

export interface CurrencyCommandTarget {
  readonly ticker: string;
  readonly network: string;
}

export interface CurrencyCommandMenu {
  readonly commands: readonly TelegramCommand[];
  readonly lookup: Readonly<Record<string, CurrencyCommandTarget>>;
}

const COMMAND_TEXT = /^\/([a-z0-9_]{1,32})(?:@[a-z0-9_]+)?$/i;

/** Имя команды из сообщения «/xlm» или «/xlm@bot». Чужой текст — undefined. */
export function parseCurrencyCommand(text: string): string | undefined {
  return COMMAND_TEXT.exec(text.trim())?.[1]?.toLowerCase();
}

export function buildCurrencyCommandMenu(
  currencies: readonly ProviderCurrency[],
): CurrencyCommandMenu {
  const byKey = new Map(
    currencies.map((currency) => [`${currency.ticker}:${currency.network}`, currency]),
  );
  const picked: ProviderCurrency[] = [];
  const seen = new Set<string>();
  for (const pair of [...POPULAR_PAIRS, ...EXTRA_COMMAND_PAIRS]) {
    for (const network of pair.networks) {
      const currency = byKey.get(`${pair.ticker}:${network}`);
      if (!currency) continue;
      const key = `${currency.ticker}:${currency.network}`;
      if (seen.has(key)) continue;
      seen.add(key);
      picked.push(currency);
      break;
    }
  }

  const tickerCount = new Map<string, number>();
  for (const currency of picked) {
    tickerCount.set(currency.ticker, (tickerCount.get(currency.ticker) ?? 0) + 1);
  }

  const taken = new Set(KEPT_COMMANDS.map((command) => command.command));
  const commands: TelegramCommand[] = [...KEPT_COMMANDS];
  const lookup: Record<string, CurrencyCommandTarget> = {};

  for (const currency of picked) {
    if (commands.length >= MAX_COMMANDS) break;
    const name = commandName(currency, (tickerCount.get(currency.ticker) ?? 0) > 1, taken);
    if (name === undefined) continue;
    taken.add(name);
    commands.push({ command: name, description: commandDescription(currency) });
    lookup[name] = { ticker: currency.ticker, network: currency.network };
  }

  return { commands, lookup };
}

function commandName(
  currency: ProviderCurrency,
  sharedTicker: boolean,
  taken: ReadonlySet<string>,
): string | undefined {
  const ticker = currency.ticker.toLowerCase();
  const suffix = (NETWORK_SUFFIX[currency.network] ?? currency.network).replace(/[^a-z0-9]/g, '');
  const qualified = suffix === '' ? ticker : `${ticker}_${suffix}`;
  const rawNetwork = currency.network.replace(/[^a-z0-9]/g, '');
  const raw = rawNetwork === '' ? qualified : `${ticker}_${rawNetwork}`;
  const candidates = sharedTicker ? [qualified, raw] : [ticker, qualified, raw];
  for (const candidate of candidates) {
    if (COMMAND_NAME.test(candidate) && !taken.has(candidate)) return candidate;
  }
  return undefined;
}

function commandDescription(currency: ProviderCurrency): string {
  const name = currency.name.replace(/\s+/g, ' ').trim();
  const fallback = currency.ticker.toUpperCase();
  const description = name.length > 0 ? name : fallback;
  return description.slice(0, 256);
}

function warn(logger: Logger, error: unknown, message: string): void {
  const description = error instanceof Error ? error.message : 'unknown';
  logger.warn({ description }, message);
}

/** Ставит меню «/» этому чату. undefined — Telegram меню не принял. */
export async function publishCurrencyCommands(
  ctx: BotContext,
  currencies: readonly ProviderCurrency[],
  logger: Logger,
): Promise<Readonly<Record<string, CurrencyCommandTarget>> | undefined> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return undefined;
  const menu = buildCurrencyCommandMenu(currencies);
  try {
    await ctx.api.setMyCommands([...menu.commands], {
      scope: { type: 'chat', chat_id: chatId },
    });
  } catch (error) {
    warn(logger, error, 'Could not set currency command menu');
    return undefined;
  }
  return menu.lookup;
}

/** Возвращает общее меню команд бота для этого чата. */
export async function clearCurrencyCommands(ctx: BotContext, logger: Logger): Promise<void> {
  const chatId = ctx.chat?.id;
  if (chatId === undefined) return;
  try {
    await ctx.api.deleteMyCommands({ scope: { type: 'chat', chat_id: chatId } });
  } catch (error) {
    warn(logger, error, 'Could not reset command menu');
  }
}
