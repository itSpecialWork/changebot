/**
 * Диалог «новый обмен»: монета и сеть отправки → монета и сеть получения → сумма →
 * адрес (→ memo) → черновик и котировка → подтверждение.
 *
 * Сеть спрашивается всегда, даже если она одна. Команда «/», которая уже называет пару,
 * выбирает её сразу. Тип курса не спрашивается: фиксированный, если пара его поддерживает,
 * иначе плавающий.
 *
 * Та же монета и та же сеть — перевод без конвертации. Другая сеть идёт обычным обменом.
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
import type {
  BotContext,
  BotDependencies,
  CurrencyChoice,
  NewExchangeFlow,
  TransferAmountBasis,
} from '../context.js';
import {
  clearCurrencyCommands,
  parseCurrencyCommand,
  publishCurrencyCommands,
} from '../currency-commands.js';
import { describeFailure } from '../error-text.js';
import { escapeHtml, formatCurrency, payoutPrompt, renderExchangeCard } from '../format.js';
import {
  cancelFlowKeyboard,
  currencyKeyboard,
  exchangeCardKeyboard,
  mainMenuKeyboard,
  selectCurrencies,
  skipExtraIdKeyboard,
  transferBasisKeyboard,
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

function transferBasisPrompt(currencyLabel: string): string {
  const labelHtml = escapeHtml(currencyLabel);
  return [
    `<blockquote>Перевод без конвертации\n<b>${labelHtml} → ${labelHtml}</b></blockquote>`,
    '',
    '<b>Что вы указываете?</b>',
    '',
    '<b>Адресат получит</b>',
    'Сколько должно прийти на адрес.',
    'Сколько отправить — посчитаем мы.',
    '',
    '<b>У меня есть сумма</b>',
    'Сколько есть у вас.',
    'Сколько придёт — посчитаем мы.',
    'К отправке будет не больше этой суммы.',
  ].join('\n');
}

function receiveAmountPrompt(currencyLabel: string): string {
  const labelHtml = escapeHtml(currencyLabel);
  return [
    `Введите сумму, которую должен получить адресат, в <b>${labelHtml}</b>.`,
    'Мы посчитаем, сколько нужно отправить.',
  ].join('\n');
}

function spendAmountPrompt(currencyLabel: string): string {
  const labelHtml = escapeHtml(currencyLabel);
  return [
    `Введите сумму, которая у вас есть, в <b>${labelHtml}</b>.`,
    'Мы посчитаем, сколько получит адресат. Отправить нужно будет не больше этой суммы.',
  ].join('\n');
}

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

function chosenRateType(from: CurrencyChoice, to: CurrencyChoice): RateType {
  return from.supportsFixedRate && to.supportsFixedRate ? 'FIXED' : 'FLOATING';
}

function resetTokenList(flow: NewExchangeFlow): void {
  flow.currencyStage = 'token';
  delete flow.pendingTicker;
  flow.networkQuery = '';
  flow.networkPage = 0;
  flow.networkScope = 'popular';
}

/** Подсказка под вопросом. Курсив отделяет её от заголовка, пустая строка даёт паузу. */
function currencyHint(flow: NewExchangeFlow, selection: CurrencySelection): string {
  if (selection.mode === 'search') {
    const query = selection.stage === 'network' ? flow.networkQuery : flow.currencyQuery;
    return `Совпадения по <code>${escapeHtml(query)}</code>.`;
  }
  if (selection.stage === 'network') return '';
  if (selection.mode === 'base') {
    return [
      'Базовые пары — кнопками ниже.',
      '',
      '<i>Нажмите «/» и введите тикер — появятся подсказки.</i>',
      '<i>Остальные монеты — кнопка «Все валюты».</i>',
    ].join('\n');
  }
  if (selection.mode === 'popular') {
    return [
      'Актуальные монеты — кнопками ниже.',
      '',
      '<i>Сеть спросим, только если у монеты их несколько.</i>',
      '<i>Нажмите «/» и введите тикер — появятся подсказки.</i>',
    ].join('\n');
  }
  return [
    'Полный список.',
    '',
    '<i>Листайте страницы или нажмите «/» и введите тикер.</i>',
    '<i>«Актуальные» вернёт короткий список.</i>',
  ].join('\n');
}

function currencyStepText(
  step: 'from' | 'to',
  flow: NewExchangeFlow,
  selection: CurrencySelection,
): string {
  if (selection.mode === 'search' && selection.items.length === 0) {
    const network = selection.stage === 'network';
    const example = network ? 'trx' : 'btc';
    const back = network ? '«Назад»' : '«Базовые»';
    const kind = network ? 'сеть' : 'тикер';
    return `Ничего не найдено.\n\nВведите ${kind}, например <code>${example}</code>, или нажмите ${back}.`;
  }

  const lines: string[] = [];
  if (step === 'to' && flow.from) {
    lines.push(`<blockquote>Отдаёте\n<b>${escapeHtml(label(flow.from))}</b></blockquote>`, '');
  } else if (step === 'from' && selection.stage === 'token') {
    lines.push('<b>Новый обмен</b>', '');
  }

  if (selection.stage === 'network') {
    const ticker = escapeHtml((flow.pendingTicker ?? '').toUpperCase());
    lines.push(`Монета\n<b>${ticker}</b>`, '', '<b>Выберите сеть.</b>');
  } else if (step === 'from') {
    lines.push('<b>Что вы отдаёте?</b>');
  } else {
    lines.push('<b>Что хотите получить?</b>');
  }

  const hint = currencyHint(flow, selection);
  if (hint !== '') lines.push('', hint);
  return lines.join('\n');
}

export function createNewExchangeHandlers(deps: BotDependencies) {
  const demo = deps.demo !== undefined;

  async function staleButton(ctx: BotContext): Promise<void> {
    ctx.session.flow = undefined;
    await clearCurrencyCommands(ctx, deps.logger);
    await show(ctx, 'Эта кнопка устарела. Начните заново.', mainMenuKeyboard());
  }

  async function leaveCurrencyMenu(ctx: BotContext, flow: NewExchangeFlow): Promise<void> {
    delete flow.currencyCommands;
    delete flow.commandMenuKey;
    await clearCurrencyCommands(ctx, deps.logger);
  }

  /** Ошибка котировки: недоступная пара сбрасывает диалог, сумма и сбой оставляют шаг. */
  async function reportQuoteFailure(ctx: BotContext, error: unknown): Promise<void> {
    if (error instanceof ExchangeProviderError && error.code === 'PAIR_NOT_SUPPORTED') {
      ctx.session.flow = undefined;
      await reply(ctx, escapeHtml(describeFailure(error) ?? ''), mainMenuKeyboard());
      return;
    }
    const message = describeFailure(error);
    if (message === undefined) throw error;
    await reply(ctx, `${escapeHtml(message)}\nОтправьте сумму ещё раз.`, cancelFlowKeyboard());
  }

  async function findCurrency(
    ticker: string,
    network: string,
  ): Promise<ProviderCurrency | undefined> {
    const currencies = await deps.exchanges.listCurrencies();
    return currencies.find((c) => c.ticker === ticker && c.network === network);
  }

  async function currenciesFor(flow: NewExchangeFlow): Promise<readonly ProviderCurrency[]> {
    const from = flow.from;
    if (flow.step === 'to' && from) {
      return deps.exchanges.listDestinationCurrencies({
        ticker: from.ticker,
        network: from.network,
      });
    }
    return deps.exchanges.listCurrencies();
  }

  async function showCurrencies(ctx: BotContext, flow: NewExchangeFlow): Promise<void> {
    if (flow.step !== 'from' && flow.step !== 'to') {
      await staleButton(ctx);
      return;
    }
    const from = flow.from;
    const currencies = await currenciesFor(flow);
    const onNetwork = flow.currencyStage === 'network' && flow.pendingTicker !== undefined;
    let selection = selectCurrencies(currencies, {
      query: onNetwork ? flow.networkQuery : flow.currencyQuery,
      page: onNetwork ? flow.networkPage : flow.currencyPage,
      catalog: flow.currencyCatalog,
      stage: onNetwork ? 'network' : 'token',
      networkScope: flow.networkScope,
      ...(flow.pendingTicker !== undefined ? { ticker: flow.pendingTicker } : {}),
    });
    if (!onNetwork && flow.currencyQuery === '' && selection.items.length === 0) {
      if (selection.mode === 'base') {
        flow.currencyCatalog = 'popular';
        selection = selectCurrencies(currencies, {
          query: '',
          page: 0,
          catalog: 'popular',
          stage: 'token',
        });
      }
      if (selection.mode === 'popular') {
        flow.currencyCatalog = 'all';
        selection = selectCurrencies(currencies, {
          query: '',
          page: 0,
          catalog: 'all',
          stage: 'token',
        });
      }
    }
    if (onNetwork) flow.networkPage = selection.page;
    else flow.currencyPage = selection.page;
    const menuKey = `${flow.step}:${from?.ticker ?? ''}:${from?.network ?? ''}`;
    if (flow.commandMenuKey !== menuKey) {
      const lookup = await publishCurrencyCommands(ctx, currencies, deps.logger);
      if (lookup) {
        flow.currencyCommands = lookup;
        flow.commandMenuKey = menuKey;
      }
    }
    const messageId = await show(
      ctx,
      currencyStepText(flow.step, flow, selection),
      currencyKeyboard(flow.step, selection),
      ctx.callbackQuery ? undefined : flow.screenMessageId,
    );
    if (messageId !== undefined) flow.screenMessageId = messageId;
  }

  async function showAmountStep(ctx: BotContext, flow: NewExchangeFlow): Promise<void> {
    const { from, to, rateType } = flow;
    if (!from || !to || !rateType) {
      await staleButton(ctx);
      return;
    }
    flow.step = 'amount';
    delete flow.amountRange;
    try {
      flow.amountRange = await deps.exchanges.getAmountRange({
        fromCurrency: from.ticker,
        fromNetwork: from.network,
        toCurrency: to.ticker,
        toNetwork: to.network,
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
    await show(ctx, amountPrompt(label(from), flow.amountRange), cancelFlowKeyboard());
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
    const pair = {
      fromCurrency: from.ticker,
      fromNetwork: from.network,
      toCurrency: to.ticker,
      toNetwork: to.network,
    };
    const draft = await deps.exchanges.createDraft({
      userId: ctx.appUser.id,
      clientRequestId: flow.id,
      ...pair,
      fromAmount: amount,
      ...(deps.exchanges.isPrivateTransferSelection(pair) ? { toAmount: amount } : {}),
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

    const pair = {
      fromCurrency: from.ticker,
      fromNetwork: from.network,
      toCurrency: to.ticker,
      toNetwork: to.network,
    };
    if (deps.exchanges.isPrivateTransferSelection(pair)) {
      if (flow.amountBasis !== 'receive' && flow.amountBasis !== 'spend') {
        await staleButton(ctx);
        return;
      }
      try {
        const estimate =
          flow.amountBasis === 'spend'
            ? await deps.exchanges.previewPrivateTransferSpend({
                currency: from.ticker,
                network: from.network,
                fromAmount: amount,
              })
            : await deps.exchanges.previewPrivateTransfer({
                currency: from.ticker,
                network: from.network,
                toAmount: amount,
              });
        flow.amount = estimate.toAmount;
        flow.step = 'address';
        await reply(
          ctx,
          [
            `Адресат получит <b>${escapeHtml(estimate.toAmount)} ${escapeHtml(label(to))}</b>.`,
            `К отправке: <b>${escapeHtml(estimate.fromAmount)} ${escapeHtml(label(from))}</b>.`,
            '',
            payoutPrompt(label(to), demo),
          ].join('\n'),
          cancelFlowKeyboard(),
        );
      } catch (error) {
        await reportQuoteFailure(ctx, error);
      }
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
      await reportQuoteFailure(ctx, error);
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
    if (flow.currencyStage === 'network') {
      flow.networkQuery = query;
      flow.networkPage = 0;
    } else {
      flow.currencyQuery = query;
      flow.currencyPage = 0;
    }
    await showCurrencies(ctx, flow);
  }

  async function onExtraId(ctx: BotContext, flow: NewExchangeFlow, text: string): Promise<void> {
    const extraId = parseExtraIdInput(text);
    if (extraId === undefined) {
      await reply(
        ctx,
        'Memo/Tag выглядит некорректно. Проверьте и отправьте ещё раз.',
        flow.to?.extraId === 'optional' ? skipExtraIdKeyboard() : cancelFlowKeyboard(),
      );
      return;
    }
    await finalize(ctx, flow, extraId);
  }

  async function selectFrom(ctx: BotContext, ticker: string, network: string): Promise<void> {
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
    flow.currencyCatalog = 'base';
    resetTokenList(flow);
    await showCurrencies(ctx, flow);
  }

  async function selectTo(ctx: BotContext, ticker: string, network: string): Promise<void> {
    const flow = ctx.session.flow;
    const currency = flow?.step === 'to' ? await findCurrency(ticker, network) : undefined;
    if (!flow?.from || !currency) {
      await staleButton(ctx);
      return;
    }
    const to = toChoice(currency);
    await leaveCurrencyMenu(ctx, flow);
    const pair = {
      fromCurrency: flow.from.ticker,
      fromNetwork: flow.from.network,
      toCurrency: to.ticker,
      toNetwork: to.network,
    };
    if (deps.exchanges.isPrivateTransferSelection(pair)) {
      flow.to = to;
      flow.rateType = 'FIXED';
      flow.step = 'transfer_basis';
      delete flow.amountRange;
      delete flow.amountBasis;
      await show(ctx, transferBasisPrompt(label(to)), transferBasisKeyboard());
      return;
    }
    if (sameCurrency(flow.from, to)) {
      await staleButton(ctx);
      return;
    }
    flow.to = to;
    flow.rateType = chosenRateType(flow.from, to);
    await showAmountStep(ctx, flow);
  }

  /** «/xlm» из меню команд. Чужая команда остаётся обычным сообщением. */
  async function applyCurrencyCommand(
    ctx: BotContext,
    flow: NewExchangeFlow,
    text: string,
  ): Promise<boolean> {
    if (flow.step !== 'from' && flow.step !== 'to') return false;
    const name = parseCurrencyCommand(text);
    const target = name === undefined ? undefined : flow.currencyCommands?.[name];
    if (!target) return false;
    if (flow.step === 'from') await selectFrom(ctx, target.ticker, target.network);
    else await selectTo(ctx, target.ticker, target.network);
    return true;
  }

  return {
    async start(ctx: BotContext): Promise<void> {
      const flow: NewExchangeFlow = {
        id: randomUUID(),
        step: 'from',
        currencyQuery: '',
        currencyPage: 0,
        currencyCatalog: 'base',
        currencyStage: 'token',
        networkScope: 'popular',
        networkQuery: '',
        networkPage: 0,
      };
      ctx.session.flow = flow;
      await showCurrencies(ctx, flow);
    },

    selectFrom,

    async selectTicker(ctx: BotContext, side: 'from' | 'to', ticker: string): Promise<void> {
      const flow = ctx.session.flow;
      if (flow?.step !== side || flow.currencyStage === 'network') {
        await staleButton(ctx);
        return;
      }
      const currencies = await currenciesFor(flow);
      const selection = selectCurrencies(currencies, {
        query: flow.currencyQuery,
        page: flow.currencyPage,
        catalog: flow.currencyCatalog,
        stage: 'token',
      });
      if (!selection.items.some((item) => item.ticker === ticker)) {
        await staleButton(ctx);
        return;
      }
      const networkScope =
        selection.mode === 'search' || selection.mode === 'all' ? 'all' : 'popular';
      const networks = selectCurrencies(currencies, {
        query: '',
        page: 0,
        catalog: flow.currencyCatalog,
        stage: 'network',
        ticker,
        networkScope,
      });
      const only =
        networks.pageCount === 1 && networks.items.length === 1 ? networks.items[0] : undefined;
      if (only !== undefined) {
        if (side === 'from') await selectFrom(ctx, only.ticker, only.network);
        else await selectTo(ctx, only.ticker, only.network);
        return;
      }
      flow.pendingTicker = ticker;
      flow.currencyStage = 'network';
      flow.networkScope = networkScope;
      flow.networkQuery = '';
      flow.networkPage = 0;
      await showCurrencies(ctx, flow);
    },

    async backToTokens(ctx: BotContext): Promise<void> {
      const flow = ctx.session.flow;
      if (
        !flow ||
        (flow.step !== 'from' && flow.step !== 'to') ||
        flow.currencyStage !== 'network'
      ) {
        await staleButton(ctx);
        return;
      }
      flow.currencyStage = 'token';
      delete flow.pendingTicker;
      flow.networkQuery = '';
      flow.networkPage = 0;
      await showCurrencies(ctx, flow);
    },

    async changePage(ctx: BotContext, direction: 'next' | 'prev'): Promise<void> {
      const flow = ctx.session.flow;
      if (!flow || (flow.step !== 'from' && flow.step !== 'to')) {
        await staleButton(ctx);
        return;
      }
      const delta = direction === 'next' ? 1 : -1;
      if (flow.currencyStage === 'network') flow.networkPage += delta;
      else flow.currencyPage += delta;
      await showCurrencies(ctx, flow);
    },

    selectTo,

    async selectTransferBasis(ctx: BotContext, basis: TransferAmountBasis): Promise<void> {
      const flow = ctx.session.flow;
      if (flow?.step !== 'transfer_basis' || !flow.to) {
        await staleButton(ctx);
        return;
      }
      flow.amountBasis = basis;
      flow.step = 'amount';
      const prompt =
        basis === 'spend' ? spendAmountPrompt(label(flow.to)) : receiveAmountPrompt(label(flow.to));
      await show(ctx, prompt, cancelFlowKeyboard());
    },

    async selectRate(ctx: BotContext): Promise<void> {
      await staleButton(ctx);
    },

    async setCatalog(ctx: BotContext, catalog: 'base' | 'popular' | 'all'): Promise<void> {
      const flow = ctx.session.flow;
      if (!flow || (flow.step !== 'from' && flow.step !== 'to')) {
        await staleButton(ctx);
        return;
      }
      resetTokenList(flow);
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
      if (!flow) return false;
      if (text.startsWith('/')) return applyCurrencyCommand(ctx, flow, text);
      switch (flow.step) {
        case 'from':
        case 'to':
          await onCurrencyQuery(ctx, flow, text);
          break;
        case 'transfer_basis':
          await reply(ctx, 'Выберите, какую сумму указать: кнопкой ниже.', transferBasisKeyboard());
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
