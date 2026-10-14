/** Заявка, которую поддержка может только прочитать. */
export interface SupportExchange {
  readonly id: string;
  readonly provider: string;
  readonly providerExchangeId: string | null;
  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;
  readonly expectedFromAmount: string;
  readonly expectedToAmount: string | null;
  readonly actualFromAmount: string | null;
  readonly actualToAmount: string | null;
  readonly payinAddress: string | null;
  readonly payinExtraId: string | null;
  readonly payoutAddress: string | null;
  readonly payoutExtraId: string | null;
  readonly refundAddress: string | null;
  readonly refundExtraId: string | null;
  readonly payinHash: string | null;
  readonly payoutHash: string | null;
  readonly refundHash: string | null;
  readonly rateType: string;
  readonly status: string;
  readonly providerStatus: string | null;
  readonly statusChangedAt: Date;
  readonly createdAt: Date;
  readonly telegramId: string;
  readonly username: string | null;
}

/** Строка списка. Адресов и memo здесь нет: их показывает уже карточка по ID. */
export interface SupportExchangeSummary {
  readonly id: string;
  readonly fromCurrency: string;
  readonly fromNetwork: string;
  readonly toCurrency: string;
  readonly toNetwork: string;
  readonly expectedFromAmount: string;
  readonly status: string;
  readonly createdAt: Date;
  readonly telegramId: string;
  readonly username: string | null;
}

export const SUPPORT_LIST_LIMIT = 20;

export type LookupHits =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly exchange: SupportExchange }
  | { readonly kind: 'many' };

export type UsernameHits =
  | { readonly kind: 'none' }
  | { readonly kind: 'empty' }
  | {
      readonly kind: 'list';
      readonly exchanges: readonly SupportExchangeSummary[];
      readonly truncated: boolean;
    };

/** Чтение заявок. Реализация не вызывает запись. */
export interface SupportLookup {
  findById(id: string): Promise<SupportExchange | null>;
  findByProviderExchangeId(providerExchangeId: string): Promise<LookupHits>;
  findByIdSuffix(suffix: string): Promise<LookupHits>;
  findByUsername(username: string): Promise<UsernameHits>;
  findByTelegramId(telegramId: string): Promise<UsernameHits>;
}

export type LookupOutcome =
  | { readonly kind: 'found'; readonly exchange: SupportExchange }
  | {
      readonly kind: 'list';
      readonly username: string;
      readonly exchanges: readonly SupportExchangeSummary[];
      readonly truncated: boolean;
    }
  | { readonly kind: 'empty'; readonly username: string }
  | { readonly kind: 'user-missing' }
  | { readonly kind: 'invalid-username' }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' };

/** Telegram username: 5–32 символа, начинается с буквы. Собака в начале обязательна. */
const USERNAME_BODY = /^[A-Za-z][A-Za-z0-9_]{4,31}$/;
/** Числовой Telegram ID. Короче пяти цифр оставляем другим поискам. */
const TELEGRAM_ID_PATTERN = /^\d{5,20}$/;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Хвост, который карточка обмена показывает до оплаты: последние 8 символов UUID. */
const SUFFIX_PATTERN = /^[0-9a-f]{8}$/i;
const MAX_QUERY_LENGTH = 128;

/**
 * @username или числовой Telegram ID — список заявок этого человека.
 * Иначе полный UUID квитанции, точный id провайдера, затем уникальный хвост из 8 символов.
 * Несколько совпадений по хвосту не раскрывают чужие заявки.
 */
export async function findSupportExchange(
  lookup: SupportLookup,
  raw: string,
): Promise<LookupOutcome> {
  const query = raw.trim().replaceAll(/[\u200B-\u200D\uFEFF]/g, '');
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) return { kind: 'missing' };

  if (query.startsWith('@')) {
    const body = query.slice(1);
    if (!USERNAME_BODY.test(body)) return { kind: 'invalid-username' };
    return usernameHits(body, await lookup.findByUsername(body));
  }

  if (TELEGRAM_ID_PATTERN.test(query)) {
    const hits = await lookup.findByTelegramId(query);
    if (hits.kind !== 'none') return usernameHits(query, hits);
    // Короче девяти цифр ещё может быть хвост UUID. Длиннее — это Telegram ID.
    if (query.length >= 9) return { kind: 'user-missing' };
  }

  if (UUID_PATTERN.test(query)) {
    const exchange = await lookup.findById(query.toLowerCase());
    return exchange === null ? { kind: 'missing' } : { kind: 'found', exchange };
  }

  const byProvider = await lookup.findByProviderExchangeId(query);
  if (byProvider.kind === 'many') return { kind: 'ambiguous' };
  if (byProvider.kind === 'one') return { kind: 'found', exchange: byProvider.exchange };

  if (SUFFIX_PATTERN.test(query)) {
    const bySuffix = await lookup.findByIdSuffix(query.toLowerCase());
    if (bySuffix.kind === 'many') return { kind: 'ambiguous' };
    if (bySuffix.kind === 'one') return { kind: 'found', exchange: bySuffix.exchange };
  }

  return { kind: 'missing' };
}

function usernameHits(label: string, hits: UsernameHits): LookupOutcome {
  if (hits.kind === 'none') return { kind: 'user-missing' };
  if (hits.kind === 'empty') return { kind: 'empty', username: label };
  return {
    kind: 'list',
    username: hits.exchanges[0]?.username ?? label,
    exchanges: hits.exchanges,
    truncated: hits.truncated,
  };
}
