import { createHash, timingSafeEqual } from 'node:crypto';

/** Сравнение пароля без утечки длины через исключение timingSafeEqual. */
export function passwordMatches(input: string, expected: string): boolean {
  const left = createHash('sha256').update(input, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
