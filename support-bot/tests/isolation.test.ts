import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('бот поддержки изолирован от обмена', () => {
  it('обменный процесс не импортирует папку поддержки', () => {
    for (const path of ['src/index.ts', 'src/compose.ts', 'src/config/env.ts']) {
      expect(readFileSync(path, 'utf8')).not.toContain('support-bot');
    }
  });

  it('запросы поддержки не пишут в базу', () => {
    const source = readFileSync('support-bot/src/prisma-lookup.ts', 'utf8');
    expect(source).not.toMatch(/\$executeRaw|\.update\(|\.delete\(|\.create\(|\.upsert\(/);
  });
});
