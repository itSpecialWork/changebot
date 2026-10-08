/**
 * Разбор JSON, в котором числовые литералы сохраняются как десятичные строки.
 *
 * Обычный JSON.parse превращает суммы в number. Для денег это запрещено:
 * исходный текст литерала становится строкой до какого-либо округления.
 */

const MAX_EXPONENT = 80n;

export class JsonDecimalError extends Error {
  constructor() {
    super('Invalid JSON decimal');
    this.name = 'JsonDecimalError';
  }
}

/** Парсит JSON и заменяет числовые литералы на их исходный десятичный текст. */
export function parseJsonNumbersAsStrings(text: string): unknown {
  return JSON.parse(quoteJsonNumbers(text)) as unknown;
}

function quoteJsonNumbers(text: string): string {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      const end = endOfString(text, index);
      out += text.slice(index, end);
      index = end;
      continue;
    }
    if (char === '-' || isDigit(char)) {
      const end = endOfNumber(text, index);
      if (end === index) {
        out += char ?? '';
        index += 1;
        continue;
      }
      out += JSON.stringify(expandDecimalLiteral(text.slice(index, end)));
      index = end;
      continue;
    }
    out += char ?? '';
    index += 1;
  }
  return out;
}

function endOfString(text: string, start: number): number {
  let index = start + 1;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  throw new JsonDecimalError();
}

function endOfNumber(text: string, start: number): number {
  let index = start;
  if (text[index] === '-') {
    index += 1;
    if (!isDigit(text[index])) return start;
  }
  if (text[index] === '0') {
    index += 1;
  } else if (isDigit(text[index])) {
    while (isDigit(text[index])) index += 1;
  } else {
    return start;
  }
  if (text[index] === '.') {
    index += 1;
    if (!isDigit(text[index])) throw new JsonDecimalError();
    while (isDigit(text[index])) index += 1;
  }
  if (text[index] === 'e' || text[index] === 'E') {
    index += 1;
    if (text[index] === '+' || text[index] === '-') index += 1;
    if (!isDigit(text[index])) throw new JsonDecimalError();
    while (isDigit(text[index])) index += 1;
  }
  return index;
}

/**
 * Раскрывает JSON-число в обычную десятичную строку.
 * Показатель степени — это сдвиг точки, не денежное умножение через number.
 */
export function expandDecimalLiteral(literal: string): string {
  const match = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/.exec(literal);
  if (!match) throw new JsonDecimalError();
  const sign = match[1] ?? '';
  const integerPart = match[2] ?? '0';
  const fractionPart = match[3] ?? '';
  const exponent = match[4] === undefined ? 0n : BigInt(match[4]);
  const digits = `${integerPart}${fractionPart}`.replace(/^0+(?=\d)/, '');
  if (/^0+$/.test(digits)) return '0';

  const scale = exponent - BigInt(fractionPart.length);
  if (scale > MAX_EXPONENT || scale < -MAX_EXPONENT) throw new JsonDecimalError();
  if (scale === 0n) return `${sign}${digits}`;
  if (scale > 0n) return `${sign}${digits}${'0'.repeat(Number(scale))}`;

  const shift = Number(-scale);
  if (digits.length <= shift) {
    const fraction = `${'0'.repeat(shift - digits.length)}${digits}`.replace(/0+$/, '');
    return fraction === '' ? '0' : `${sign}0.${fraction}`;
  }
  const whole = digits.slice(0, digits.length - shift);
  const fraction = digits.slice(digits.length - shift).replace(/0+$/, '');
  return fraction === '' ? `${sign}${whole}` : `${sign}${whole}.${fraction}`;
}

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}
