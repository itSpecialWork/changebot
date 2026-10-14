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

export type FlowStep = 'from' | 'to' | 'transfer_basis' | 'amount' | 'address' | 'extra_id';

/** Сначала имя монеты, затем её сети. */
export type CurrencyStage = 'token' | 'network';

/** Откуда открыт экран сети: короткий список или весь каталог этой монеты. */
export type NetworkScope = 'popular' | 'all';

/** В переводе одной монеты: сумма получателя или сумма, которая есть у отправителя. */
export type TransferAmountBasis = 'receive' | 'spend';

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
  /** Какую сумму ввёл пользователь на переводе одной монеты. */
  amountBasis?: TransferAmountBasis;
  payoutAddress?: string;
  /** Фильтр списка монет. Пустая строка — без поиска. */
  currencyQuery: string;
  currencyPage: number;
  /** Базовые пары, актуальные монеты или полный каталог. */
  currencyCatalog: 'base' | 'popular' | 'all';
  /** Имя монеты или выбор сети уже выбранной монеты. */
  currencyStage: CurrencyStage;
  /** Монета, для которой открыт экран сети. */
  pendingTicker?: string;
  /** Сети короткого списка или все сети монеты из текущего каталога. */
  networkScope: NetworkScope;
  /** Фильтр на экране сети. */
  networkQuery: string;
  networkPage: number;
  /** Сообщение с кнопками валют. Новый ввод тикера обновляет его, а не шлёт ещё одно. */
  screenMessageId?: number;
  /**
   * Команды меню «/» на шаге выбора валюты: имя команды → монета.
   * Telegram показывает их как подсказки, пока пользователь набирает «/».
   */
  currencyCommands?: Readonly<
    Record<string, { readonly ticker: string; readonly network: string }>
  >;
  /** Для какого шага меню «/» уже отправлено в Telegram. */
  commandMenuKey?: string;
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

/** Кнопка «Открыть обмен». `webApp` — окно Telegram и нужен https. Иначе ссылка открывается в браузере. */
export interface WidgetButton {
  readonly url: string;
  readonly webApp: boolean;
}

export interface BotDependencies {
  readonly exchanges: ExchangeService;
  readonly users: UserService;
  readonly logger: Logger;
  readonly demo?: DemoControls;
  readonly now?: () => Date;
  /** Нет значения только в тестах. В боевом процессе кнопка есть всегда. */
  readonly widgetButton?: WidgetButton;
}
