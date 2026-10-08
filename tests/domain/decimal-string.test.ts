import { describe, expect, it } from 'vitest';
import {
  compareDecimal,
  formatDecimal,
  InvalidDecimalError,
  multiplyDecimal,
  parseDecimal,
} from '../../src/domain/shared/decimal-string.js';

describe('decimal-string', () => {
  it('парсит и форматирует без потери точности', () => {
    expect(formatDecimal(parseDecimal('100.5'))).toBe('100.5');
    expect(formatDecimal(parseDecimal('0.000000000000000000000001'))).toBe(
      '0.000000000000000000000001',
    );
    expect(formatDecimal(parseDecimal('2.500'))).toBe('2.5');
    expect(formatDecimal(parseDecimal('7'))).toBe('7');
    expect(formatDecimal(parseDecimal('00012.0'))).toBe('12');
  });

  it('не теряет точность там, где ломается Float', () => {
    expect(multiplyDecimal('0.1', '3')).toBe('0.3');
    expect(multiplyDecimal('0.3', '3')).toBe('0.9');
    expect(multiplyDecimal('12345678901234567890', '0.000001')).toBe('12345678901234.56789');
  });

  it('округляет результат умножения вниз', () => {
    expect(multiplyDecimal('0.000000000000000000000001', '0.5')).toBe('0');
    expect(multiplyDecimal('0.000000000000000000000003', '0.5')).toBe('0.000000000000000000000001');
  });

  it.each(['', '-1', '1e3', '1,5', ' 1', '1.', '.5', 'abc', '0.0000000000000000000000001'])(
    'отклоняет некорректное значение %j',
    (value) => {
      expect(() => parseDecimal(value)).toThrow(InvalidDecimalError);
    },
  );

  it('отклоняет слишком большую целую часть', () => {
    expect(() => parseDecimal('1'.repeat(27))).toThrow(InvalidDecimalError);
    expect(() => parseDecimal('1'.repeat(26))).not.toThrow();
  });

  it('сравнивает значения численно, а не лексикографически', () => {
    expect(compareDecimal('9', '10')).toBe(-1);
    expect(compareDecimal('1.50', '1.5')).toBe(0);
    expect(compareDecimal('0.002', '0.0019')).toBe(1);
  });
});
