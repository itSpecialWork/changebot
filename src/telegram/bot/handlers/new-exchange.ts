/**
 * Диалог «новый обмен»: валюта отправки → валюта получения → тип курса → сумма →
 * адрес (→ memo) → черновик и котировка → подтверждение.
 *
 * Обработчики собирают ввод и вызывают ExchangeService; проверки пары, суммы и сети
 * выполняет сервис и провайдер. Состояние диалога живёт в сессии (память процесса).
 */
import { randomUUID } from 'node:crypto';
import {
  ExchangeProviderError,
  type ProviderAmountRange,
  type ProviderCurrency,
  type RateType,
} from '../../../domain/exchanges/exchange-provider.js';
import {
  compareDecimal,
  formatDecimal,
  parseDecimal,
} from '../../../domain/shared/decimal-string.js';
import type { BotContext, BotDependencies, CurrencyChoice, NewExchangeFlow } from '../context.js';
import { describeFailure } from '../error-text.js';
import { escapeHtml, formatCurrency, payoutPrompt, renderExchangeCard } from '../format.js';
import {
  cancelFlowKeyboard,
  currencyKeyboard,
  exchangeCardKeyboard,
  mainMenuKeyboard,
  rateTypeKeyboard,
  selectCurrencies,
  skipExtraIdKeyboard,
  type CurrencySelection,
} from '../keyboards.js';
import { parseAddressInput, parseAmountInput, parseExtraIdInput } from '../input.js';
import { reply, show } from '../ui.js';

function toChoice(currency: ProviderCurrency): CurrencyChoice {
  return {
    ticker: currency.ticker,
    network: currency.network,
    supportsFixedRate: currency.supportsFixedRate,
    extraId: currency.extraId,
  };
}

function label(choice: CurrencyChoice): string {
  return formatCurrency(choice.ticker, choice.network);
}

function sameCurrency(a: CurrencyChoice, b: CurrencyChoice): boolean {
  return a.ticker === b.ticker && a.network === b.network;
}

const MAX_CURRENCY_QUERY = 32;

function amountPrompt(currencyLabel: string, range: ProviderAmountRange | undefined): string {
  const lines = [`Введите сумму, которую хотите отдать, в <b>${escapeHtml(currencyLabel)}</b>.`];
  if (range === undefined) {
    lines.push(
      'Допустимый диапазон сейчас недоступен. Введите положительное число — мы проверим его.',
    );
    return lines.join('\n');
  }
  lines.push(`Минимум: <b>${escapeHtml(range.minAmount)}</b>.`);
  if (range.maxAmount !== null) {
    lines.push(`Максимум: <b>${escapeHtml(range.maxAmount)}</b>.`);
  }
  lines.push('Сумма вне этого диапазона не будет принята.');
  return lines.join('\n');
}

function invalidAmountText(flow: NewExchangeFlow): string {
  const min = flow.amountRange?.minAmount;
  if (min === undefined) {
    return 'Это не сумма. Введите положительное число.';
  }
  return `Это не сумма. Введите положительное число не меньше минимума <b>${escapeHtml(min)}</b>.`;
}

/** Сумма уже разобрана. undefined — она внутри известного диапазона или диапазон неизвестен. */
function amountOutOfRangeText(amount: string, flow: NewExchangeFlow): string | undefined {
  const range = flow.amountRange;
  const currency = flow.from ? label(flow.from) : '';
  if (compareDecimal(amount, '0') === 0) {
    return 'Сумма должна быть больше нуля.';
  }
  if (range !== undefined && compareDecimal(amount, range.minAmount) < 0) {
    return `Сумма меньше минимума для этой пары: <b>${escapeHtml(range.minAmount)} ${escapeHtml(currency)}</b>.`;
  }
  if (
    range?.maxAmount !== undefined &&
    range.maxAmount !== null &&
    compareDecimal(amount, range.maxAmount) > 0
  ) {
    return `Сумма больше максимума для этой пары: <b>${escapeHtml(range.maxAmount)} ${escapeHtml(currency)}</b>.`;
  }
  return undefined;
}

function readAmount(text: string): string | undefined {
  const parsed = parseAmountInput(text);
  if (parsed === undefined) return undefined;
  try {
    return formatDecimal(parseDecimal(parsed));
  } catch {
    return undefined;
  }
}

function currencyStepText(
  step: 'from' | 'to',
  flow: NewExchangeFlow,
  selection: CurrencySelection,
): string {
  if (selection.mode === 'search' && selection.items.length === 0) {
    return 'Ничего не найдено. Введите тикер, например <code>btc</code>.';
  }
  const queryLine =
    selection.mode === 'search'
      ? `\nСовпадения по запросу <code>${escapeHtml(flow.currencyQuery)}</code>.`
      : selection.mode === 'popular'
        ? '\nАктуальные валюты ниже. Полный список — кнопка «Все валюты». Или напишите тикер, например <code>btc</code>.'
        : '\nПолный список. Листайте страницы или напишите тикер. Кнопка «Актуальные» вернёт короткий список.';
  if (step === 'from') {
    return `<b>Новый обмен</b>\nЧто вы отдаёте?${queryLine}`;
  }
  const from = flow.from;
  const head = from
    ? `Вы отдаёте: <b>${escapeHtml(label(from))}</b>\nЧто хотите получить?`
    : 'Что хотите получить?';
  return `${head}${queryLine}`;
}

export function createNewExchangeHandlers(deps: BotDependencies) {
  const demo = deps.demo !== undefined;

  async function staleButton(ctx: BotContext): Promise<void> {
    ctx.session.flow = undefined;
    await show(ctx, 'Эта кнопка устарела. Начните заново.', mainMenuKeyboard());
  }

  async function findCurrency(
    ticker: string,
    network: string,
  ): Promise<ProviderCurrency | undefined> {
    const currencies = await deps.exchanges.listCurrencies();
    return currencies.find((c) => c.ticker === ticker && c.network === network);
  }

  async function showCurrencies(ctx: BotContext, flow: NewExchangeFlow): Promise<void> {
    if (flow.step !== 'from' && flow.step !== 'to') {
      await staleButton(ctx);
      return;
    }
    const all = await deps.exchanges.listCurrencies();
    const from = flow.from;
    const currencies =
      flow.step === 'to' && from
        ? all.filter(
            (currency) => !(currency.ticker === from.ticker && currency.network === from.network),
          )
        : all;
    let selection = selectCurrencies(currencies, {
      query: flow.currencyQuery,
      page: flow.currencyPage,
      catalog: flow.currencyCatalog,
    });
    if (selection.mode === 'popular' && selection.items.length === 0) {
      flow.currencyCatalog = 'all';
      selection = selectCurrencies(currencies, {
        query: '',
        page: 0,
        catalog: 'all',
      });
    }
    flow.currencyPage = selection.page;
    await show(
      ctx,
      currencyStepText(flow.step, flow, selection),
      currencyKeyboard(flow.step, selection),
    );
  }

  /** Создаёт черновик, получает котировку и показывает карточку подтверждения. */
  async function finalize(
    ctx: BotContext,
    flow: NewExchangeFlow,
    extraId: string | null,
  ): Promise<void> {
    const { from, to, rateType, amount, payoutAddress } = flow;
    if (!from || !to || !rateType || amount === undefined || payoutAddress === undefined) {
      await staleButton(ctx);
      return;
    }

    // flow.id — ключ идемпотентности: повторная отправка того же сообщения не создаст дубль.
    const draft = await deps.exchanges.createDraft({
      userId: ctx.appUser.id,
      clientRequestId: flow.id,
      fromCurrency: from.ticker,
      fromNetwork: from.network,
      toCurrency: to.ticker,
      toNetwork: to.network,
      fromAmount: amount,
      rateType,
      payoutAddress,
      payoutExtraId: extraId,
    });
    ctx.session.flow = undefined;

    try {
      const exchange = await deps.exchanges.prepareConfirmation(ctx.appUser.id, draft.id);
      await reply(
        ctx,
        renderExchangeCard(exchange, { demo }),
        exchangeCardKeyboard(exchange, { demo }),
      );
    } catch (error) {
      const text = describeFailure(error);
      if (text === undefined) throw error;
      // Черновик сохранён: его можно продолжить из карточки.
      await reply(
        ctx,
        `${escapeHtml(text)}\n\n${renderExchangeCard(draft, { demo })}`,
        exchangeCardKeyboard(draft, { demo }),
      );
    }
  }

  async function onAmount(ctx: BotContext, flow: NewExchangeFlow, text: string): Promise<void> {
    const { from, to, rateType } = flow;
    if (!from || !to || !rateType) {
      await staleButton(ctx);
      return;
    }
    const amount = readAmount(text);
    if (amount === undefined) {
      await reply(ctx, invalidAmountText(flow), cancelFlowKeyboard());
      return;
    }
    const outOfRange = amountOutOfRangeText(amount, flow);
    if (outOfRange !== undefined) {
      await reply(ctx, outOfRange, cancelFlowKeyboard());
      return;
    }

    let toAmount: string;
    let normalized: string;
    try {
      const quote = await deps.exchanges.previewQuote({
        fromCurrency: from.ticker,
        fromNetwork: from.network,
        toCurrency: to.ticker,
        toNetwork: to.network,
        fromAmount: amount,
        rateType,
      });
      toAmount = quote.toAmount;
      normalized = quote.fromAmount;
    } catch (error) {
      if (error instanceof ExchangeProviderError && error.code === 'PAIR_NOT_SUPPORTED') {
        ctx.session.flow = undefined;
        await reply(ctx, escapeHtml(describeFailure(error) ?? ''), mainMenuKeyboard());
        return;
      }
      // Неверная сумма, выход за лимиты или временный сбой: остаёмся на шаге суммы.
      const message = describeFailure(error);
      if (message === undefined) throw error;
      await reply(ctx, `${escapeHtml(message)}\nОтправьте сумму ещё раз.`, cancelFlowKeyboard());
      return;
    }

    flow.amount = normalized;
    flow.step = 'address';
    const approx = rateType === 'FLOATING' ? '≈ ' : '';
    await reply(
      ctx,
      [
        `По текущему курсу вы получите <b>${approx}${escapeHtml(toAmount)} ${escapeHtml(label(to))}</b>.`,
        '',
        payoutPrompt(label(to), demo),
      ].join('\n'),
      cancelFlowKeyboard(),
    );
  }

  async function onAddress(ctx: BotContext, flow: NewExchangeFlow, text: string): Promise<void> {
    const to = flow.to;
    if (!to) {
      await staleButton(ctx);
      return;
    }
    const address = parseAddressInput(text);
    if (address === undefined) {
      await reply(
        ctx,
        'Адрес выглядит некорректно. Проверьте его и отправьте ещё раз.',
        cancelFlowKeyboard(),
      );
      return;
    }
    flow.payoutAddress = address;

    if (to.extraId === 'none') {
      await finalize(ctx, flow, null);
      return;
    }
    flow.step = 'extra_id';
    if (to.extraId === 'required') {
      await reply(
        ctx,
        `Для ${escapeHtml(label(to))} нужен Memo/Tag. Отправьте его.`,
        cancelFlowKeyboard(),
      );
    } else {
      await reply(
        ctx,
        'Если для вашего кошелька нужен Memo/Tag, отправьте его. Иначе нажмите «Пропустить».',
        skipExtraIdKeyboard(),
      );
    }
  }

  async function onCurrencyQuery(
    ctx: BotContext,
    flow: NewExchangeFlow,
    text: string,
  ): Promise<void> {
    const query = text.trim().toLowerCase();
    if (query.length > MAX_CURRENCY_QUERY) {
      await reply(
        ctx,
        'Слишком длинный запрос. Введите короткий тикер, например <code>btc</code>.',
        cancelFlowKeyboard(),
      );
      return;
    }
    flow.currencyQuery = query;
    flow.currencyPage = 0;
    await showCurrencies(ctx, flow);
  }

  async function onExtraId(ctx: BotContext, flow: NewExchangeFlow, text: string): Promise<void> {
    const extraId = parseExtraIdInput(text);
    if (extraId === undefined) {
      await reply(
        ctx,
        'Memo/Tag выглядит некорректно. Проверьте и отправьте ещё раз.',
        cancelFlowKeyboard(),
      );
      return;
    }
    await finalize(ctx, flow, extraId);
  }

  return {
    async start(ctx: BotContext): Promise<void> {
      const flow: NewExchangeFlow = {
        id: randomUUID(),
        step: 'from',
        currencyQuery: '',
        currencyPage: 0,
        currencyCatalog: 'popular',
      };
      ctx.session.flow = flow;
      await showCurrencies(ctx, flow);
    },

    async selectFrom(ctx: BotContext, ticker: string, network: string): Promise<void> {
      const flow = ctx.session.flow;
      const currency = flow?.step === 'from' ? await findCurrency(ticker, network) : undefined;
      if (!flow || !currency) {
        await staleButton(ctx);
        return;
      }
      flow.from = toChoice(currency);
      flow.step = 'to';
      flow.currencyQuery = '';
      flow.currencyPage = 0;
      flow.currencyCatalog = 'popular';
      await showCurrencies(ctx, flow);
    },

    async changePage(ctx: BotContext, direction: 'next' | 'prev'): Promise<void> {
      const flow = ctx.session.flow;
      if (!flow || (flow.step !== 'from' && flow.step !== 'to')) {
        await staleButton(ctx);
        return;
      }
      flow.currencyPage = direction === 'next' ? flow.currencyPage + 1 : flow.currencyPage - 1;
      await showCurrencies(ctx, flow);
    },

    async selectTo(ctx: BotContext, ticker: string, network: string): Promise<void> {
      const flow = ctx.session.flow;
      const currency = flow?.step === 'to' ? await findCurrency(ticker, network) : undefined;
      if (!flow?.from || !currency || sameCurrency(flow.from, toChoice(currency))) {
        await staleButton(ctx);
        return;
      }
      flow.to = toChoice(currency);
      flow.step = 'rate';
      await show(
        ctx,
        `${escapeHtml(label(flow.from))} → <b>${escapeHtml(label(flow.to))}</b>\n\nВыберите тип курса:\n• плавающий — итог зависит от рынка на момент обмена;\n• фиксированный — сумма получения гарантирована на время действия котировки.`,
        rateTypeKeyboard(flow.from.supportsFixedRate && flow.to.supportsFixedRate),
      );
    },

    async selectRate(ctx: BotContext, rateType: RateType): Promise<void> {
      const flow = ctx.session.flow;
      const fixedAvailable =
        flow?.from?.supportsFixedRate === true && flow.to?.supportsFixedRate === true;
      if (
        flow?.step !== 'rate' ||
        !flow.from ||
        !flow.to ||
        (rateType === 'FIXED' && !fixedAvailable)
      ) {
        await staleButton(ctx);
        return;
      }
      flow.rateType = rateType;
      flow.step = 'amount';
      delete flow.amountRange;
      try {
        flow.amountRange = await deps.exchanges.getAmountRange({
          fromCurrency: flow.from.ticker,
          fromNetwork: flow.from.network,
          toCurrency: flow.to.ticker,
          toNetwork: flow.to.network,
          rateType,
        });
      } catch (error) {
        if (error instanceof ExchangeProviderError && error.code === 'PAIR_NOT_SUPPORTED') {
          ctx.session.flow = undefined;
          await reply(ctx, escapeHtml(describeFailure(error) ?? ''), mainMenuKeyboard());
          return;
        }
        if (!(error instanceof ExchangeProviderError)) throw error;
        deps.logger.warn({ code: error.code }, 'Amount range is unavailable');
      }
      await show(ctx, amountPrompt(label(flow.from), flow.amountRange), cancelFlowKeyboard());
    },

    async setCatalog(ctx: BotContext, catalog: 'popular' | 'all'): Promise<void> {
      const flow = ctx.session.flow;
      if (!flow || (flow.step !== 'from' && flow.step !== 'to')) {
        await staleButton(ctx);
        return;
      }
      flow.currencyCatalog = catalog;
      flow.currencyQuery = '';
      flow.currencyPage = 0;
      await showCurrencies(ctx, flow);
    },

    async skipExtraId(ctx: BotContext): Promise<void> {
      const flow = ctx.session.flow;
      if (flow?.step !== 'extra_id' || flow.to?.extraId !== 'optional') {
        await staleButton(ctx);
        return;
      }
      await finalize(ctx, flow, null);
    },

    /**
     * Текстовое сообщение как ввод для текущего шага диалога.
     * Возвращает false, если диалога нет и сообщение никто не ждал.
     */
    async onText(ctx: BotContext, text: string): Promise<boolean> {
      const flow = ctx.session.flow;
      if (!flow || text.startsWith('/')) return false;
      switch (flow.step) {
        case 'from':
        case 'to':
          await onCurrencyQuery(ctx, flow, text);
          break;
        case 'amount':
          await onAmount(ctx, flow, text);
          break;
        case 'address':
          await onAddress(ctx, flow, text);
          break;
        case 'extra_id':
          await onExtraId(ctx, flow, text);
          break;
        default:
          await reply(ctx, 'Выберите вариант кнопкой в сообщении выше.', cancelFlowKeyboard());
      }
      return true;
    },
  };
}
