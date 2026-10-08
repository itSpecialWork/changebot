/**
 * Арифметика над десятичными суммами, представленными строками.
 *
 * Деньги никогда не проходят через number/Float. Формат совпадает с колонками БД
 * Decimal(50, 24): до 26 цифр в целой части и до 24 в дробной. Отрицательные
 * значения и экспоненциальная запись не поддерживаются.
 */

const FRACTION_DIGITS = 24;
const MAX_INTEGER_DIGITS = 26;
const SCALE = 10n ** BigInt(FRACTION_DIGITS);
const DECIMAL_PATTERN = new RegExp(
  `^(\\d{1,${String(MAX_INTEGER_DIGITS)}})(?:\\.(\\d{1,${String(FRACTION_DIGITS)}}))?$`,
);

export class InvalidDecimalError extends Error {
  constructor() {
    super('Invalid decimal amount');
    this.name = 'InvalidDecimalError';
  }
}

/** Преобразует строку вида "100.5" в целое число, умноженное на 10^24. */
export function parseDecimal(value: string): bigint {
  const match = DECIMAL_PATTERN.exec(value);
  if (!match) {
    throw new InvalidDecimalError();
  }
  const [, integerPart = '', fractionPart = ''] = match;
  return BigInt(integerPart) * SCALE + BigInt(fractionPart.padEnd(FRACTION_DIGITS, '0'));
}

/** Обратное преобразование: без лишних нулей в конце ("100.5", "2", "0.001"). */
export function formatDecimal(scaled: bigint): string {
  if (scaled < 0n) {
    throw new InvalidDecimalError();
  }
  const integerPart = (scaled / SCALE).toString();
  const fractionPart = (scaled % SCALE)
    .toString()
    .padStart(FRACTION_DIGITS, '0')
    .replace(/0+$/, '');
  return fractionPart === '' ? integerPart : `${integerPart}.${fractionPart}`;
}

/** Сравнение двух десятичных строк: -1, 0 или 1. */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = parseDecimal(a);
  const right = parseDecimal(b);
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * Умножение с округлением вниз до 24 знаков. Округление вниз выбрано намеренно:
 * ожидаемая сумма получения не должна быть завышена относительно реальной.
 */
export function multiplyDecimal(a: string, b: string): string {
  return formatDecimal((parseDecimal(a) * parseDecimal(b)) / SCALE);
}
