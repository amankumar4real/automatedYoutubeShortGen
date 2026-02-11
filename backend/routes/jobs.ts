import { Router, Request, Response } from 'express';
import path from 'path';
import { runShortPipeline, RunShortOptions, RunShortResult } from '../pipeline/index';
import { authMiddleware, AuthRequest } from '../middleware';
import { logger } from '../logger';

type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'waiting_for_clips';

type Job = {
  id: string;
  status: JobStatus;
  topic: string;
  startedAt: string;
  finishedAt?: string;
  outputPath?: string;
  youtubeMetaPath?: string | null;
  errorMessage?: string;
  requiredFiles?: string[];
};

const jobs = new Map<string, Job>();

function createJobId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

async function startJob(opts: RunShortOptions): Promise<Job> {
  const id = createJobId();
  const job: Job = {
    id,
    status: 'queued',
    topic: opts.topic ?? '',
    startedAt: new Date().toISOString()
  };
  jobs.set(id, job);

  (async () => {
    job.status = 'running';
    try {
      const result: RunShortResult = await runShortPipeline(opts);
      if (result.status === 'waiting_for_clips') {
        job.status = 'waiting_for_clips';
        job.finishedAt = new Date().toISOString();
        job.topic = result.topic || job.topic;
        job.requiredFiles = result.requiredFiles ?? [];
      } else {
        job.status = 'done';
        job.finishedAt = new Date().toISOString();
        job.topic = result.topic || job.topic;
        job.outputPath = result.outputPath;
        job.youtubeMetaPath = result.youtubeMetaPath;
      }
    } catch (err) {
      job.status = 'error';
      job.finishedAt = new Date().toISOString();
      job.errorMessage = (err as Error).message;
      logger.error('Job failed', err, { jobId: id });
    }
  })();

  return job;
}

const router = Router();
router.use(authMiddleware);

router.post('/', async (req: Request, res: Response) => {
  const body = req.body as { topic?: string; reuseTemp?: boolean };
  try {
    const job = await startJob({
      topic: body.topic,
      reuseTemp: body.reuseTemp ?? false,
      testMode: false
    });
    res.status(202).json({ jobId: job.id, status: job.status, topic: job.topic });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/', (_req: Request, res: Response) => {
  const list = Array.from(jobs.values())
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, 20)
    .map((j) => ({
      id: j.id,
      status: j.status,
      topic: j.topic,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt
    }));
  res.json(list);
});

router.get('/:id', (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const mediaUrl =
    job.status === 'done' && job.outputPath
      ? `/media/${path.basename(job.outputPath)}`
      : null;
  const metaUrl =
    job.status === 'done' && job.youtubeMetaPath
      ? `/media/${path.basename(job.youtubeMetaPath)}`
      : null;

  return res.json({
    id: job.id,
    status: job.status,
    topic: job.topic,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    errorMessage: job.errorMessage,
    requiredFiles: job.requiredFiles,
    mediaUrl,
    metaUrl
  });
});

router.post('/:id/continue', async (req: Request, res: Response) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'waiting_for_clips') {
    return res.status(400).json({
      error: 'Job is not waiting for clips. Only jobs with status waiting_for_clips can be continued.'
    });
  }

  job.status = 'running';
  job.finishedAt = undefined;
  job.errorMessage = undefined;

  try {
    const result = await runShortPipeline({ runStep: 4, reuseTemp: true });
    job.status = 'done';
    job.finishedAt = new Date().toISOString();
    job.outputPath = result.outputPath;
    job.youtubeMetaPath = result.youtubeMetaPath;
    job.requiredFiles = undefined;
    return res.json({
      id: job.id,
      status: job.status,
      mediaUrl: `/media/${path.basename(result.outputPath)}`,
      metaUrl: result.youtubeMetaPath ? `/media/${path.basename(result.youtubeMetaPath)}` : null
    });
  } catch (err) {
    job.status = 'error';
    job.finishedAt = new Date().toISOString();
    job.errorMessage = (err as Error).message;
    logger.error('Continue failed', err, { jobId: job.id });
    return res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
