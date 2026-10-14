import { pino } from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { localWidgetPageUrl, widgetPageUrl } from '../src/http/widget-page.js';

const logger = pino({ level: 'silent' });

describe('GET /widget', () => {
  it('отдаёт встройку виджета и скрипт следующего шага', async () => {
    const app = createApp({ logger, checkDatabase: () => Promise.resolve(true) });

    const response = await request(app).get('/widget');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.text).toContain('id="iframe-widget"');
    expect(response.text).toContain('from=usdttrc20');
    expect(response.text).toContain('to=usdttrc20');
    expect(response.text).toContain('link_id=782584e7ba7d59');
    expect(response.text).toContain(
      'https://changenow.io/embeds/exchange-widget/v2/stepper-connector.js',
    );
  });

  it('собирает локальный и публичный адрес страницы', () => {
    expect(localWidgetPageUrl('127.0.0.1', 3000)).toBe('http://127.0.0.1:3000/widget');
    expect(localWidgetPageUrl('0.0.0.0', 3000)).toBe('http://127.0.0.1:3000/widget');
    expect(widgetPageUrl('https://exchange.example.com')).toBe(
      'https://exchange.example.com/widget',
    );
  });
});
