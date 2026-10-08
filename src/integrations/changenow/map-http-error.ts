/**
 * HTTP-ошибки ChangeNOW → ExchangeProviderError.
 *
 * В сообщение попадает только наш стабильный текст. Сырой `message` провайдера
 * может содержать адрес или rateId, поэтому наружу он не копируется.
 *
 * Код `out_of_range` взят из коллекции Postman (сумма меньше минимума).
 */
import { ExchangeProviderError } from '../../domain/exchanges/exchange-provider.js';
import { parseJsonNumbersAsStrings } from './decimal-json.js';
import { changeNowErrorSchema } from './schemas.js';

export function mapChangeNowHttpError(status: number, body: string): ExchangeProviderError {
  if (status === 404) return new ExchangeProviderError('NOT_FOUND', 'Exchange not found');
  if (status === 401 || status === 403 || status === 408 || status === 429 || status >= 500) {
    return new ExchangeProviderError('UNAVAILABLE', 'Provider is unavailable');
  }
  if (status === 400) return mapBadRequest(body);
  if (status >= 400 && status < 500) {
    return new ExchangeProviderError('INVALID_REQUEST', 'Invalid provider request');
  }
  return new ExchangeProviderError('UNAVAILABLE', 'Provider is unavailable');
}

function mapBadRequest(body: string): ExchangeProviderError {
  const parsed = readError(body);
  const code = parsed?.error;
  const message = (parsed?.message ?? '').toLowerCase();

  if (
    code === 'out_of_range' ||
    message.includes('minimal') ||
    message.includes('maximum') ||
    message.includes('out of range') ||
    message.includes('less then') ||
    message.includes('greater than')
  ) {
    return new ExchangeProviderError('AMOUNT_OUT_OF_RANGE', 'Amount is out of allowed range');
  }
  if (code === 'rate_id_not_found_or_expired') {
    return new ExchangeProviderError('QUOTE_EXPIRED', 'Fixed quote has expired');
  }
  if (
    code === 'not_valid_params' &&
    (message.includes('not supported') || message.includes('pair') || message.includes('currency'))
  ) {
    return new ExchangeProviderError('PAIR_NOT_SUPPORTED', 'Currency pair is not supported');
  }
  if (message.includes('invalid id') || code === 'not_found') {
    return new ExchangeProviderError('NOT_FOUND', 'Exchange not found');
  }
  return new ExchangeProviderError('INVALID_REQUEST', 'Invalid provider request');
}

function readError(
  body: string,
): { readonly error: string; readonly message?: string } | undefined {
  try {
    const parsed = changeNowErrorSchema.safeParse(parseJsonNumbersAsStrings(body));
    if (!parsed.success) return undefined;
    if (parsed.data.message === undefined) return { error: parsed.data.error };
    return { error: parsed.data.error, message: parsed.data.message };
  } catch {
    return undefined;
  }
}
