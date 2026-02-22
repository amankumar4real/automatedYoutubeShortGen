import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware';
import { suggestTopics, suggestTrendingTopics } from '../topicService';
import { logger } from '../logger';

const router = Router();

router.use(authMiddleware);

/**
 * POST /api/topics/suggest
 * Body: { previous?: string[] }
 * Response: { topics: string[] }
 */
router.post('/suggest', async (req: AuthRequest, res: Response) => {
  const body = req.body as { previous?: unknown; provider?: string };
  const previous =
    Array.isArray(body.previous) && body.previous.every((t) => typeof t === 'string')
      ? (body.previous as string[])
      : [];
  const provider = body.provider === 'grok' ? 'grok' as const : 'openai';

  try {
    const topics = await suggestTopics(previous, provider);
    return res.json({ topics });
  } catch (err) {
    logger.error('Topic suggestion failed', err as Error);
    return res.status(503).json({ error: 'Topic suggestion unavailable' });
  }
});

/**
 * POST /api/topics/trending
 * Body: { previous?: string[] }
 * Response: { topics: string[] }
 * Uses Serper + GPT to suggest topics that are trending now and fit the same domain as suggest.
 */
router.post('/trending', async (req: AuthRequest, res: Response) => {
  const body = req.body as { previous?: unknown; provider?: string };
  const previous =
    Array.isArray(body?.previous) && body.previous.every((t) => typeof t === 'string')
      ? (body.previous as string[])
      : [];
  const provider = body?.provider === 'grok' ? 'grok' as const : 'openai';
  try {
    const topics = await suggestTrendingTopics(previous, provider);
    return res.json({ topics });
  } catch (err) {
    logger.error('Trending topics failed', err as Error);
    return res.status(503).json({ error: 'Trending topics unavailable' });
  }
});

export default router;

