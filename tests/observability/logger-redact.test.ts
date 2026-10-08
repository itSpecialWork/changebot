import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import { redactPaths } from '../../src/observability/logger.js';

describe('маскирование логов', () => {
  it('скрывает ключ ChangeNOW и заголовок API', () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const logger = pino(
      { level: 'info', redact: { paths: redactPaths, censor: '[REDACTED]' } },
      stream,
    );
    const secret = 'super-secret-key';
    logger.info(
      {
        changeNowApiKey: secret,
        headers: { 'x-changenow-api-key': secret },
      },
      'boot',
    );

    const text = lines.join('');
    expect(text).toContain('[REDACTED]');
    expect(text).not.toContain(secret);
  });
});
