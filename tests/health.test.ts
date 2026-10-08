import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';

const logger = pino({ level: 'silent' });

describe('GET /health', () => {
  it('возвращает 200 и status ok, когда БД доступна', async () => {
    const app = createApp({ logger, checkDatabase: () => Promise.resolve(true) });

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', database: 'up' });
    expect(typeof (response.body as { timestamp: unknown }).timestamp).toBe('string');
  });

  it('возвращает 503, когда БД недоступна', async () => {
    const app = createApp({ logger, checkDatabase: () => Promise.resolve(false) });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'degraded', database: 'down' });
  });

  it('возвращает 503, если проверка БД выбросила ошибку', async () => {
    const app = createApp({
      logger,
      checkDatabase: () => Promise.reject(new Error('boom')),
    });

    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
  });

  it('возвращает 404 для неизвестного маршрута и не раскрывает x-powered-by', async () => {
    const app = createApp({ logger, checkDatabase: () => Promise.resolve(true) });

    const response = await request(app).get('/unknown');

    expect(response.status).toBe(404);
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});
