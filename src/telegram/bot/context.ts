/**
 * Типы Telegram-слоя: контекст grammY, состояние диалога и зависимости бота.
 *
 * Бот зависит только от application-сервисов. Провайдера обмена, БД и репозиториев
 * он не знает: бизнес-логика живёт в ExchangeService и UserService.
 */
import type { Context, SessionFlavor } from 'grammy';
import type { ExchangeService } from '../../application/exchanges/exchange-service.js';
import type { UserService } from '../../application/users/user-service.js';
import type {
  ExtraIdRequirement,
  ProviderAmountRange,
  RateType,
} from '../../domain/exchanges/exchange-provider.js';
import type { UserRecord } from '../../domain/users/user.js';
import type { Logger } from '../../observability/logger.js';

export interface CurrencyChoice {
  readonly ticker: string;
  readonly network: string;
  readonly supportsFixedRate: boolean;
  readonly extraId: ExtraIdRequirement;
}

export type FlowStep = 'from' | 'to' | 'rate' | 'amount' | 'address' | 'extra_id';

/**
 * Незавершённый диалог «новый обмен». Живёт только в памяти (до 30 минут бездействия):
 * пока обмен не создан, терять нечего. Идентификатор `id` служит ключом идемпотентности
 * при создании черновика, поэтому повторная отправка последнего сообщения дубля не создаст.
 */
export interface NewExchangeFlow {
  readonly id: string;
  step: FlowStep;
  from?: CurrencyChoice;
  to?: CurrencyChoice;
  rateType?: RateType;
  /**
   * Сумма в нормализованном виде (десятичная строка).
   * Для обмена это сумма отправки, для перевода одной монеты — сумма получения.
   */
  amount?: string;
  payoutAddress?: string;
  /** Фильтр каталога на шагах выбора валюты. Пустая строка — без поиска. */
  currencyQuery: string;
  currencyPage: number;
  /** Короткий список актуальных валют или полный каталог. */
  currencyCatalog: 'popular' | 'all';
  /** Диапазон суммы, известный на шаге ввода. Нет, если провайдер его не отдал. */
  amountRange?: ProviderAmountRange;
}

export interface SessionData {
  flow: NewExchangeFlow | undefined;
}

export interface UserFlavor {
  /** Пользователь приложения; заполняется middleware до обработчиков. */
  appUser: UserRecord;
}

export type BotContext = Context & SessionFlavor<SessionData> & UserFlavor;

/** Управление тестовым провайдером. Передаётся только в демо-режиме (MockExchangeProvider). */
export interface DemoControls {
  /** Двигает обмен у провайдера на следующий статус. Бросает ошибку, если двигать некуда. */
  advanceProviderStatus(providerExchangeId: string): void;
}

export interface BotDependencies {
  readonly exchanges: ExchangeService;
  readonly users: UserService;
  readonly logger: Logger;
  readonly demo?: DemoControls;
  readonly now?: () => Date;
}
