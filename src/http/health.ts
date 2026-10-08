import { Router } from 'express';

export type HealthCheck = () => Promise<boolean>;

export function createHealthRouter({ checkDatabase }: { checkDatabase: HealthCheck }): Router {
  const router = Router();

  router.get('/health', async (_req, res) => {
    const databaseUp = await checkDatabase().catch(() => false);

    res.status(databaseUp ? 200 : 503).json({
      status: databaseUp ? 'ok' : 'degraded',
      database: databaseUp ? 'up' : 'down',
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
