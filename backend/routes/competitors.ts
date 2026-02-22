import { Router, Response } from 'express';
import { authMiddleware, AuthRequest } from '../middleware';
import { analyzeCompetitorChannels, discoverChannelsByTheme } from '../competitorService';
import { logger } from '../logger';
import { setCompetitorIntelForUser, getCompetitorIntelForUser } from '../userIntel';

const router = Router();

router.use(authMiddleware);

router.post('/analyze', async (req: AuthRequest, res: Response) => {
  const body = req.body as { channels?: unknown; maxPerChannel?: unknown };
  const channels = Array.isArray(body.channels) ? body.channels.filter((c): c is string => typeof c === 'string') : [];
  const maxPerChannel = typeof body.maxPerChannel === 'number' ? body.maxPerChannel : 20;
  if (!channels.length) {
    return res.status(400).json({ error: 'channels is required (array of channel handles/ids/urls)' });
  }
  try {
    const result = await analyzeCompetitorChannels(channels, maxPerChannel);
    await setCompetitorIntelForUser(req.user!.id, {
      updatedAt: new Date().toISOString(),
      channels: result.channels.map((c) => ({
        input: c.input,
        channelId: c.channelId,
        channelTitle: c.channelTitle,
        uploads: c.uploads.map((u) => ({
          videoId: u.videoId,
          title: u.title,
          publishedAt: u.publishedAt,
          duration: u.duration,
          viewCount: u.viewCount
        }))
      })),
      insights: result.insights
    });
    return res.json(result);
  } catch (err) {
    logger.error('Competitor analysis failed', err as Error);
    return res.status(500).json({ error: (err as Error).message || 'Competitor analysis failed' });
  }
});

router.get('/latest', async (req: AuthRequest, res: Response) => {
  try {
    const intel = await getCompetitorIntelForUser(req.user!.id);
    return res.json({ intel });
  } catch (err) {
    logger.error('Competitor latest fetch failed', err as Error);
    return res.status(500).json({ error: 'Failed to load latest competitor insights' });
  }
});

router.post('/discover', async (req: AuthRequest, res: Response) => {
  const body = req.body as { theme?: unknown; maxResults?: unknown; minSubscribers?: unknown };
  const theme = typeof body.theme === 'string' ? body.theme.trim() : '';
  const maxResults = typeof body.maxResults === 'number' ? body.maxResults : 12;
  const minSubscribers = typeof body.minSubscribers === 'number' ? body.minSubscribers : 10000;
  if (!theme) return res.status(400).json({ error: 'theme is required' });
  try {
    const channels = await discoverChannelsByTheme(theme, maxResults, minSubscribers);
    return res.json({ theme, minSubscribers, channels });
  } catch (err) {
    logger.error('Competitor discovery failed', err as Error);
    return res.status(500).json({ error: (err as Error).message || 'Competitor discovery failed' });
  }
});

export default router;
