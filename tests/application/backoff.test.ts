import { describe, expect, it } from 'vitest';
import { computeBackoffDelayMs } from '../../src/application/exchanges/backoff.js';

describe('computeBackoffDelayMs', () => {
  it('удваивает задержку с каждой неудачей', () => {
    expect(computeBackoffDelayMs(1, 1000, 60_000)).toBe(1000);
    expect(computeBackoffDelayMs(2, 1000, 60_000)).toBe(2000);
    expect(computeBackoffDelayMs(3, 1000, 60_000)).toBe(4000);
  });

  it('не превышает максимум, в том числе при огромном числе неудач', () => {
    expect(computeBackoffDelayMs(10, 1000, 60_000)).toBe(60_000);
    expect(computeBackoffDelayMs(10_000, 1000, 60_000)).toBe(60_000);
  });

  it('нулевое и отрицательное число неудач даёт базовую задержку', () => {
    expect(computeBackoffDelayMs(0, 1000, 60_000)).toBe(1000);
    expect(computeBackoffDelayMs(-5, 1000, 60_000)).toBe(1000);
  });
});
