import { Router, Request, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware';
import { suggestTopics } from '../topicService';
import { logger } from '../logger';

const router = Router();

router.use(authMiddleware);

/**
 * POST /api/topics/suggest
 * Body: { previous?: string[] }
 * Response: { topics: string[] }
 */
router.post('/suggest', async (req: AuthRequest, res: Response) => {
  const body = req.body as { previous?: unknown };
  const previous =
    Array.isArray(body.previous) && body.previous.every((t) => typeof t === 'string')
      ? (body.previous as string[])
      : [];

  try {
    const topics = await suggestTopics(previous);
    return res.json({ topics });
  } catch (err) {
    logger.error('Topic suggestion failed', err as Error);
    return res.status(503).json({ error: 'Topic suggestion unavailable' });
  }
});

export default router;

