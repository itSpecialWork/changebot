import { describe, expect, it } from 'vitest';
import {
  expandDecimalLiteral,
  parseJsonNumbersAsStrings,
} from '../../../src/integrations/changenow/decimal-json.js';

describe('десятичные литералы JSON', () => {
  it('сохраняет исходный текст суммы, а не number', () => {
    expect(parseJsonNumbersAsStrings('{"depositFee":0.0001302,"toAmount":3434.835033}')).toEqual({
      depositFee: '0.0001302',
      toAmount: '3434.835033',
    });
  });

  it('раскрывает экспоненту строковым сдвигом точки', () => {
    expect(expandDecimalLiteral('1.2e-7')).toBe('0.00000012');
    expect(expandDecimalLiteral('1.20e-7')).toBe('0.00000012');
    expect(expandDecimalLiteral('1e2')).toBe('100');
    expect(expandDecimalLiteral('0.0')).toBe('0');
    expect(parseJsonNumbersAsStrings('{"toAmount":1.2e-7}')).toEqual({ toAmount: '0.00000012' });
  });

  it('не трогает числа внутри строк', () => {
    expect(parseJsonNumbersAsStrings('{"name":"1.2e-7","ok":true,"n":null}')).toEqual({
      name: '1.2e-7',
      ok: true,
      n: null,
    });
  });
});
