import { Router, Request, Response } from 'express';
import { getDb } from '../db';

const router = Router();

/** Liveness: process is up */
router.get('/health', (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/** Readiness: DB (and optional deps) are reachable */
router.get('/ready', async (_req: Request, res: Response) => {
  try {
    await getDb();
    res.json({ ok: true });
  } catch (err) {
    res.status(503).json({ ok: false, error: 'Database unavailable' });
  }
});

export default router;
