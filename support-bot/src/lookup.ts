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

export type LookupHits =
  | { readonly kind: 'none' }
  | { readonly kind: 'one'; readonly exchange: SupportExchange }
  | { readonly kind: 'many' };

/** Чтение заявок. Реализация не вызывает запись. */
export interface SupportLookup {
  findById(id: string): Promise<SupportExchange | null>;
  findByProviderExchangeId(providerExchangeId: string): Promise<LookupHits>;
  findByIdSuffix(suffix: string): Promise<LookupHits>;
}

export type LookupOutcome =
  | { readonly kind: 'found'; readonly exchange: SupportExchange }
  | { readonly kind: 'missing' }
  | { readonly kind: 'ambiguous' };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Хвост, который карточка обмена показывает до оплаты: последние 8 символов UUID. */
const SUFFIX_PATTERN = /^[0-9a-f]{8}$/i;
const MAX_QUERY_LENGTH = 128;

/**
 * Полный UUID квитанции, затем точный id провайдера, затем уникальный хвост из 8 символов.
 * Несколько совпадений не раскрывают чужие заявки.
 */
export async function findSupportExchange(
  lookup: SupportLookup,
  raw: string,
): Promise<LookupOutcome> {
  const query = raw.trim();
  if (query.length === 0 || query.length > MAX_QUERY_LENGTH) return { kind: 'missing' };

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
