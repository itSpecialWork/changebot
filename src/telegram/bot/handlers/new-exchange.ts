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
  type ProviderCurrency,
  type RateType,
} from '../../../domain/exchanges/exchange-provider.js';
import type { BotContext, BotDependencies, CurrencyChoice, NewExchangeFlow } from '../context.js';
import { describeFailure } from '../error-text.js';
import { escapeHtml, formatCurrency, payoutPrompt, renderExchangeCard } from '../format.js';
import {
  cancelFlowKeyboard,
  currencyKeyboard,
  exchangeCardKeyboard,
  mainMenuKeyboard,
  rateTypeKeyboard,
  skipExtraIdKeyboard,
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
    const amount = parseAmountInput(text);
    if (amount === undefined) {
      await reply(
        ctx,
        'Введите сумму числом, например <code>100</code> или <code>0.5</code>.',
        cancelFlowKeyboard(),
      );
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
      const currencies = await deps.exchanges.listCurrencies();
      ctx.session.flow = { id: randomUUID(), step: 'from' };
      await show(ctx, '<b>Новый обмен</b>\nЧто вы отдаёте?', currencyKeyboard(currencies, 'from'));
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
      const currencies = await deps.exchanges.listCurrencies();
      await show(
        ctx,
        `Вы отдаёте: <b>${escapeHtml(label(flow.from))}</b>\nЧто хотите получить?`,
        currencyKeyboard(
          currencies.filter((c) => !(c.ticker === ticker && c.network === network)),
          'to',
        ),
      );
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
      if (flow?.step !== 'rate' || !flow.from || (rateType === 'FIXED' && !fixedAvailable)) {
        await staleButton(ctx);
        return;
      }
      flow.rateType = rateType;
      flow.step = 'amount';
      await show(
        ctx,
        `Введите сумму, которую хотите отдать, в <b>${escapeHtml(label(flow.from))}</b>.\nНапример: <code>100</code> или <code>0.5</code>`,
        cancelFlowKeyboard(),
      );
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
