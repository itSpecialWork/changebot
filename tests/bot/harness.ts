/**
 * Стенд для тестов бота без сети и БД: настоящие ExchangeService, UserService и
 * MockExchangeProvider поверх репозиториев в памяти, а вызовы Telegram API перехватываются.
 */
import type { Bot } from 'grammy';
import type { Update } from 'grammy/types';
import { ExchangeStatusConflictError } from '../../src/application/exchanges/errors.js';
import type {
  CheckFailureParams,
  CheckSuccessParams,
  ClaimDueParams,
  ExchangeRepository,
  NewDraft,
  TransitionParams,
} from '../../src/application/exchanges/exchange-repository.js';
import { ExchangeService } from '../../src/application/exchanges/exchange-service.js';
import type { UserRepository } from '../../src/application/users/user-repository.js';
import { UserService } from '../../src/application/users/user-service.js';
import type { BotContext } from '../../src/bot/context.js';
import { createBot } from '../../src/bot/create-bot.js';
import type { ExchangeRecord } from '../../src/domain/exchanges/exchange.js';
import type { TelegramProfile, UserRecord } from '../../src/domain/users/user.js';
import { MockExchangeProvider } from '../../src/integrations/mock/mock-exchange-provider.js';
import { createLogger } from '../../src/observability/logger.js';

export class InMemoryExchangeRepository implements ExchangeRepository {
  readonly rows = new Map<string, ExchangeRecord>();
  private sequence = 0;

  createDraft(draft: NewDraft): Promise<{ exchange: ExchangeRecord; created: boolean }> {
    const existing = [...this.rows.values()].find((r) => r.idempotencyKey === draft.idempotencyKey);
    if (existing) return Promise.resolve({ exchange: existing, created: false });

    this.sequence += 1;
    const now = new Date();
    const exchange: ExchangeRecord = {
      id: `00000000-0000-7000-8000-${String(this.sequence).padStart(12, '0')}`,
      userId: draft.userId,
      provider: draft.provider,
      providerExchangeId: null,
      idempotencyKey: draft.idempotencyKey,
      fromCurrency: draft.fromCurrency,
      fromNetwork: draft.fromNetwork,
      toCurrency: draft.toCurrency,
      toNetwork: draft.toNetwork,
      expectedFromAmount: draft.expectedFromAmount,
      expectedToAmount: null,
      actualFromAmount: null,
      actualToAmount: null,
      payinAddress: null,
      payinExtraId: null,
      payoutAddress: draft.payoutAddress,
      payoutExtraId: draft.payoutExtraId,
      refundAddress: draft.refundAddress,
      refundExtraId: draft.refundExtraId,
      rateType: draft.rateType,
      providerRateId: null,
      quoteExpiresAt: null,
      status: 'DRAFT',
      providerStatus: null,
      statusChangedAt: now,
      nextCheckAt: draft.nextCheckAt,
      lastCheckedAt: null,
      checkFailureCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(exchange.id, exchange);
    return Promise.resolve({ exchange, created: true });
  }

  findById(exchangeId: string): Promise<ExchangeRecord | null> {
    return Promise.resolve(this.rows.get(exchangeId) ?? null);
  }

  listByUser(userId: string, limit: number): Promise<ExchangeRecord[]> {
    const own = [...this.rows.values()].filter((r) => r.userId === userId);
    return Promise.resolve(own.reverse().slice(0, limit));
  }

  transition(params: TransitionParams): Promise<ExchangeRecord> {
    const row = this.require(params.exchangeId, params.from);
    const updated: ExchangeRecord = {
      ...row,
      ...params.patch,
      status: params.to,
      statusChangedAt: params.at,
      nextCheckAt: params.nextCheckAt,
      checkFailureCount: 0,
    };
    this.rows.set(row.id, updated);
    return Promise.resolve(updated);
  }

  recordCheckFailure(params: CheckFailureParams): Promise<ExchangeRecord> {
    const row = this.require(params.exchangeId, params.expectedStatus);
    const updated = {
      ...row,
      checkFailureCount: row.checkFailureCount + 1,
      nextCheckAt: params.nextCheckAt,
    };
    this.rows.set(row.id, updated);
    return Promise.resolve(updated);
  }

  recordCheckSuccess(params: CheckSuccessParams): Promise<ExchangeRecord> {
    const row = this.require(params.exchangeId, params.expectedStatus);
    const updated = { ...row, checkFailureCount: 0, nextCheckAt: params.nextCheckAt };
    this.rows.set(row.id, updated);
    return Promise.resolve(updated);
  }

  claimDueForProviderCheck(_params: ClaimDueParams): Promise<string[]> {
    return Promise.resolve([]);
  }

  private require(exchangeId: string, expected: ExchangeRecord['status']): ExchangeRecord {
    const row = this.rows.get(exchangeId);
    if (row?.status !== expected) {
      throw new ExchangeStatusConflictError(exchangeId, expected, row?.status ?? 'EXPIRED');
    }
    return row;
  }
}

export class InMemoryUserRepository implements UserRepository {
  readonly users = new Map<string, UserRecord>();

  upsertFromTelegram(profile: TelegramProfile): Promise<UserRecord> {
    const key = profile.telegramId.toString();
    const existing = this.users.get(key);
    const user: UserRecord = {
      id: existing?.id ?? `user-${key}`,
      ...profile,
      botBlockedAt: null,
    };
    this.users.set(key, user);
    return Promise.resolve(user);
  }
}

export interface ApiCall {
  readonly method: string;
  readonly payload: Record<string, unknown>;
}

const BOT_INFO = { id: 1, is_bot: true, first_name: 'Test', username: 'test_bot' };

export class BotHarness {
  readonly exchangeRepository = new InMemoryExchangeRepository();
  readonly userRepository = new InMemoryUserRepository();
  readonly provider = new MockExchangeProvider();
  readonly calls: ApiCall[] = [];
  readonly bot: Bot<BotContext>;
  readonly exchanges: ExchangeService;
  private updateId = 0;

  private constructor() {
    const logger = createLogger({ nodeEnv: 'test', logLevel: 'silent' });
    this.exchanges = new ExchangeService({
      repository: this.exchangeRepository,
      provider: this.provider,
      providerKind: 'MOCK',
      logger,
    });
    this.bot = createBot({
      token: '123456:TEST_TOKEN_FOR_UNIT_TESTS_ONLY_0000000',
      exchanges: this.exchanges,
      users: new UserService(this.userRepository),
      logger,
      demo: {
        advanceProviderStatus: (id) => {
          this.provider.advanceStatus(id);
        },
      },
      rateLimit: { limit: 10_000, windowMs: 1000 },
    });

    this.bot.api.config.use((_prev, method, payload) => {
      this.calls.push({ method, payload: payload });
      const chat = { id: 1, type: 'private' };
      const result =
        method === 'getMe'
          ? BOT_INFO
          : method === 'sendMessage'
            ? { message_id: 1000, date: 0, chat, text: 'sent' }
            : true;
      return Promise.resolve({ ok: true, result } as never);
    });
  }

  static async create(): Promise<BotHarness> {
    const harness = new BotHarness();
    await harness.bot.init();
    return harness;
  }

  private nextId(): number {
    this.updateId += 1;
    return this.updateId;
  }

  async sendText(userId: number, text: string, chatType = 'private'): Promise<void> {
    const entities = text.startsWith('/')
      ? [{ type: 'bot_command' as const, offset: 0, length: text.split(' ')[0]?.length ?? 0 }]
      : undefined;
    const update: Update = {
      update_id: this.nextId(),
      message: {
        message_id: this.nextId(),
        date: 0,
        chat: { id: userId, type: chatType, first_name: 'Tester' } as never,
        from: { id: userId, is_bot: false, first_name: 'Tester' },
        text,
        ...(entities ? { entities } : {}),
      },
    };
    await this.bot.handleUpdate(update);
  }

  async pressButton(userId: number, data: string): Promise<void> {
    const update: Update = {
      update_id: this.nextId(),
      callback_query: {
        id: String(this.nextId()),
        from: { id: userId, is_bot: false, first_name: 'Tester' },
        chat_instance: 'test',
        data,
        message: {
          message_id: 500,
          date: 0,
          chat: { id: userId, type: 'private', first_name: 'Tester' },
          text: 'old',
        },
      },
    };
    await this.bot.handleUpdate(update);
  }

  /** Вызовы, которые бот сделал после последнего clearCalls(). */
  messages(): ApiCall[] {
    return this.calls.filter((c) => c.method === 'sendMessage' || c.method === 'editMessageText');
  }

  last(): ApiCall {
    const call = this.messages().at(-1);
    if (!call) throw new Error('Bot sent nothing');
    return call;
  }

  lastText(): string {
    return String(this.last().payload.text);
  }

  /** callback_data всех кнопок последнего сообщения. */
  lastButtons(): string[] {
    const markup = this.last().payload.reply_markup as
      { inline_keyboard: { callback_data?: string }[][] } | undefined;
    return (markup?.inline_keyboard ?? []).flat().flatMap((b) => b.callback_data ?? []);
  }

  clearCalls(): void {
    this.calls.length = 0;
  }
}
