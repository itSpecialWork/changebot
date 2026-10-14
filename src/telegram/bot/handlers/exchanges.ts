/**
 * Список обменов и карточка обмена. Обработчики только вызывают ExchangeService
 * и показывают результат: правила переходов статусов находятся в сервисе.
 */
import {
  ExchangeNotSyncableError,
  ExchangeStatusConflictError,
} from '../../../application/exchanges/errors.js';
import { ExchangeProviderError } from '../../../domain/exchanges/exchange-provider.js';
import type { ExchangeRecord } from '../../../domain/exchanges/exchange.js';
import type { BotContext, BotDependencies } from '../context.js';
import { describeFailure } from '../error-text.js';
import { escapeHtml, renderExchangeCard } from '../format.js';
import { exchangeCardKeyboard, exchangeListKeyboard, mainMenuKeyboard } from '../keyboards.js';
import { show } from '../ui.js';

const LIST_LIMIT = 10;

export function createExchangeHandlers(deps: BotDependencies) {
  const demo = deps.demo !== undefined;

  async function showCard(
    ctx: BotContext,
    exchange: ExchangeRecord,
    notice?: string,
    fullReceipt = false,
  ): Promise<void> {
    const card = renderExchangeCard(exchange, { demo, fullReceipt });
    const text = notice ? `${escapeHtml(notice)}\n\n${card}` : card;
    await show(ctx, text, exchangeCardKeyboard(exchange, { demo, fullReceipt }));
  }

  async function showCurrent(ctx: BotContext, exchangeId: string, notice?: string): Promise<void> {
    await showCard(ctx, await deps.exchanges.getForUser(ctx.appUser.id, exchangeId), notice);
  }

  return {
    async list(ctx: BotContext): Promise<void> {
      const exchanges = await deps.exchanges.listForUser(ctx.appUser.id, LIST_LIMIT);
      const pendingAddress = ctx.session.flow?.step === 'address';
      const warning = pendingAddress ? '<b>Жду адрес, обмен ещё не создан.</b>\n\n' : '';
      if (exchanges.length === 0 && !pendingAddress) {
        await show(ctx, 'У вас пока нет обменов.', mainMenuKeyboard(deps.widgetButton));
        return;
      }
      const body =
        exchanges.length === 0
          ? 'У вас пока нет обменов.'
          : '<b>Ваши обмены</b>\nПоследние обмены, новые сверху:';
      await show(ctx, `${warning}${body}`, exchangeListKeyboard(exchanges, { pendingAddress }));
    },

    async open(ctx: BotContext, exchangeId: string): Promise<void> {
      await showCurrent(ctx, exchangeId);
    },

    /** Полная квитанция показывает хеш выплаты. Короткая карточка его снова прячет. */
    async showReceipt(ctx: BotContext, exchangeId: string, full: boolean): Promise<void> {
      await showCard(
        ctx,
        await deps.exchanges.getForUser(ctx.appUser.id, exchangeId),
        undefined,
        full,
      );
    },

    /** DRAFT/QUOTED → AWAITING_CONFIRMATION: свежая котировка и запрос подтверждения. */
    async prepare(ctx: BotContext, exchangeId: string): Promise<void> {
      const exchange = await deps.exchanges.prepareConfirmation(ctx.appUser.id, exchangeId);
      await showCard(ctx, exchange);
    },

    /** Подтверждение: единственное место, откуда запускается создание обмена у провайдера. */
    async confirm(ctx: BotContext, exchangeId: string): Promise<void> {
      try {
        await showCard(ctx, await deps.exchanges.confirmAndCreate(ctx.appUser.id, exchangeId));
      } catch (error) {
        // Повторное нажатие или сбой провайдера: показываем актуальное состояние обмена.
        if (error instanceof ExchangeStatusConflictError) {
          await showCurrent(ctx, exchangeId, 'Обмен уже обработан, вот его текущее состояние.');
        } else if (error instanceof ExchangeProviderError) {
          await showCurrent(ctx, exchangeId, describeFailure(error));
        } else {
          throw error;
        }
      }
    },

    async cancel(ctx: BotContext, exchangeId: string): Promise<void> {
      await showCard(
        ctx,
        await deps.exchanges.cancelByUser(ctx.appUser.id, exchangeId),
        'Обмен отменён.',
      );
    },

    /** Только в тестовом режиме: двигает обмен у mock-провайдера и сразу сверяет статус. */
    async advanceDemo(ctx: BotContext, exchangeId: string): Promise<void> {
      if (!deps.demo) {
        await showCurrent(ctx, exchangeId);
        return;
      }
      const exchange = await deps.exchanges.getForUser(ctx.appUser.id, exchangeId);
      if (exchange.providerExchangeId === null) {
        await showCard(ctx, exchange, 'У этого обмена ещё нет записи у провайдера.');
        return;
      }

      try {
        deps.demo.advanceProviderStatus(exchange.providerExchangeId);
      } catch (error) {
        const notice =
          error instanceof ExchangeProviderError && error.code === 'NOT_FOUND'
            ? 'Тестовый провайдер не помнит этот обмен (он создан до перезапуска бота).'
            : 'Тестовый провайдер не может двигать этот обмен дальше.';
        await showCard(ctx, exchange, notice);
        return;
      }

      try {
        // Сверка с провайдером меняет статус и ставит уведомление в outbox.
        const { exchange: synced } = await deps.exchanges.syncWithProvider(exchange.id);
        await showCard(
          ctx,
          synced,
          'Тестовый провайдер сменил статус. Уведомление придёт отдельным сообщением.',
        );
      } catch (error) {
        if (error instanceof ExchangeNotSyncableError) {
          await showCurrent(ctx, exchangeId);
          return;
        }
        throw error;
      }
    },
  };
}
