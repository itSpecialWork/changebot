/**
 * Предварительный разбор текста, который пользователь вводит в диалоге.
 *
 * Это только защита от очевидного мусора. Принадлежность адреса конкретной сети
 * проверяет провайдер обмена: поддельная «проверка формата» дала бы ложное чувство безопасности.
 */

const AMOUNT_PATTERN = /^\d+(?:\.\d+)?$/;
const ADDRESS_PATTERN = /^[A-Za-z0-9:._+/=-]{10,128}$/;
const EXTRA_ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

/** "100", "0.5", "0,5" → "100", "0.5", "0.5"; всё остальное (в том числе "1e5", "-1") → undefined. */
export function parseAmountInput(text: string): string | undefined {
  const normalized = text.trim().replace(',', '.');
  return normalized.length <= 60 && AMOUNT_PATTERN.test(normalized) ? normalized : undefined;
}

export function parseAddressInput(text: string): string | undefined {
  const value = text.trim();
  return ADDRESS_PATTERN.test(value) ? value : undefined;
}

/** Memo / tag / extraId. */
export function parseExtraIdInput(text: string): string | undefined {
  const value = text.trim();
  return EXTRA_ID_PATTERN.test(value) ? value : undefined;
}
