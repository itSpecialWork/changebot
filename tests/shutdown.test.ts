import { createServer } from 'node:http';
import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { createShutdown } from '../src/http/shutdown.js';

const logger = pino({ level: 'silent' });

async function startServer(): Promise<ReturnType<typeof createServer>> {
  const server = createServer((_req, res) => res.end('ok'));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('createShutdown', () => {
  it('закрывает сервер, вызывает cleanup и завершает процесс с кодом 0', async () => {
    const server = await startServer();
    const cleanup = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 5000, cleanup, exit });

    await shutdown('test');

    expect(server.listening).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('идемпотентна: повторный вызов не запускает cleanup второй раз', async () => {
    const server = await startServer();
    const cleanup = vi.fn(() => Promise.resolve());
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 5000, cleanup, exit });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    expect(cleanup).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
  });

  it('завершает процесс с кодом 1, если cleanup упал', async () => {
    const server = await startServer();
    const cleanup = vi.fn(() => Promise.reject(new Error('disconnect failed')));
    const exit = vi.fn();
    const shutdown = createShutdown({ server, logger, timeoutMs: 5000, cleanup, exit });

    await shutdown('test');

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});
