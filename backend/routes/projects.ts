import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import {
  createProject,
  listProjects,
  getProjectByProjectId,
  getAssetUrl,
  getProjectWorkspaceDir,
  getProjectOutputDir,
  updateProject,
  uploadProjectFile,
  deleteProject
} from '../projects';
import { getObjectJson } from '../r2';
import { runProjectPipeline, runProjectAssembly } from '../projectRunner';
import { authMiddleware, AuthRequest } from '../middleware';
import { logger } from '../logger';
import { config } from '../config';

const router = Router();
router.use(authMiddleware);

const OUTPUT_DIR = path.resolve(config.workspaceRoot, 'output');
const upload = multer({ dest: path.join(config.workspaceRoot, 'temp', 'uploads') });

router.post('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const body = req.body as { topic?: string; idempotencyKey?: string };
  const topic = body.topic?.trim();
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  const idempotencyKey = body.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined);
  try {
    const { project, created } = await createProject(userId, topic, idempotencyKey);
    if (created) {
      (async () => {
        try {
          await runProjectPipeline(userId, project.projectId, project.topic, false);
        } catch (err) {
          logger.error('Project pipeline failed', err, { projectId: project.projectId });
        }
      })();
    }
    res.status(created ? 201 : 200).json({
      projectId: project.projectId,
      topic: project.topic,
      status: project.status,
      currentStage: project.currentStage,
      updatedAt: project.updatedAt.toISOString(),
      finalVideoUrl: null,
      existing: !created
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  try {
    const projects = await listProjects(userId);
    const list = await Promise.all(
      projects.map(async (p) => ({
        projectId: p.projectId,
        topic: p.topic,
        status: p.status,
        currentStage: p.currentStage,
        updatedAt: p.updatedAt.toISOString(),
        finalVideoUrl: p.finalVideoKey ? await getAssetUrl(p.finalVideoKey) : null
      }))
    );
    res.json(list);
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:projectId/script', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const scriptPath = path.join(getProjectWorkspaceDir(projectId), 'script.json');
  const scriptPathExists = fs.existsSync(scriptPath);

  interface ScriptData {
    voiceover: string;
    scenes: Array<{ prompt: string; voiceover?: string; duration?: number }>;
  }
  let script: ScriptData | null = null;

  if (project.scriptKey) {
    script = await getObjectJson<ScriptData>(project.scriptKey);
    if (!script) {
      try {
        const url = await getAssetUrl(project.scriptKey);
        if (url) {
          const resp = await fetch(url);
          if (resp.ok) script = (await resp.json()) as ScriptData;
        }
      } catch {
        /* fall back to local file */
      }
    }
  }

  if (!script) {
    if (scriptPathExists) {
      try {
        script = JSON.parse(fs.readFileSync(scriptPath, 'utf-8')) as ScriptData;
      } catch {
        /* ignore */
      }
    }
  }

  if (!script || typeof script.voiceover !== 'string' || !Array.isArray(script.scenes)) {
    return res.status(404).json({ error: 'Script not found' });
  }
  return res.json({ voiceover: script.voiceover, scenes: script.scenes });
});

router.get('/:projectId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const [scriptUrl, finalVideoUrlR2, youtubeMetaUrlR2, audioUrlR2] = await Promise.all([
    getAssetUrl(project.scriptKey),
    getAssetUrl(project.finalVideoKey),
    getAssetUrl(project.youtubeMetaKey),
    project.audioKeys?.[0] ? getAssetUrl(project.audioKeys[0]) : Promise.resolve(null)
  ]);
  const outputDir = getProjectOutputDir(projectId);
  const finalVideoUrl =
    finalVideoUrlR2 ??
    (fs.existsSync(path.join(outputDir, 'final_short.mp4'))
      ? `/api/projects/${projectId}/media/final_short.mp4`
      : null);
  const youtubeMetaUrl =
    youtubeMetaUrlR2 ??
    (fs.existsSync(path.join(outputDir, 'youtube_meta.json'))
      ? `/api/projects/${projectId}/media/youtube_meta.json`
      : null);

  res.json({
    projectId: project.projectId,
    topic: project.topic,
    status: project.status,
    currentStage: project.currentStage,
    stageHistory: project.stageHistory,
    scriptUrl,
    finalVideoUrl: finalVideoUrl ?? null,
    youtubeMetaUrl: youtubeMetaUrl ?? null,
    audioUrl: audioUrlR2,
    requiredFiles: project.requiredFiles,
    errorMessage: project.errorMessage,
    updatedAt: project.updatedAt.toISOString(),
    createdAt: project.createdAt.toISOString()
  });
});

router.get('/:projectId/meta', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  let meta: Record<string, unknown> | null = null;

  if (project.youtubeMetaKey) {
    try {
      const url = await getAssetUrl(project.youtubeMetaKey);
      if (url) {
        const resp = await fetch(url);
        if (resp.ok) meta = (await resp.json()) as Record<string, unknown>;
      }
    } catch {
      /* fall back to local file */
    }
  }

  if (!meta) {
    const outputDir = getProjectOutputDir(projectId);
    const metaPath = path.join(outputDir, 'youtube_meta.json');
    if (fs.existsSync(metaPath)) {
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as Record<string, unknown>;
      } catch {
        /* ignore */
      }
    }
  }

  if (!meta) return res.status(404).json({ error: 'Metadata not found' });
  return res.json(meta);
});

router.post('/:projectId/continue', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'waiting_for_clips') {
    return res.status(400).json({
      error: 'Project is not waiting for clips. Only projects with status waiting_for_clips can be continued.'
    });
  }
  try {
    await runProjectAssembly(userId, projectId);
    const updated = await getProjectByProjectId(projectId, userId);
    if (!updated) return res.status(500).json({ error: 'Project not found after continue' });
    const [finalVideoUrl, youtubeMetaUrl] = await Promise.all([
      getAssetUrl(updated.finalVideoKey),
      getAssetUrl(updated.youtubeMetaKey)
    ]);
    return res.json({
      projectId: updated.projectId,
      status: updated.status,
      finalVideoUrl,
      youtubeMetaUrl
    });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.post('/:projectId/clips', upload.any(), async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'waiting_for_clips') {
    return res.status(400).json({ error: 'Project is not waiting for clips' });
  }
  const files = (req as { files?: Express.Multer.File[] }).files;
  if (!files?.length) return res.status(400).json({ error: 'No files uploaded' });

  const workspace = getProjectWorkspaceDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  const clipKeys: string[] = [...(project.clipKeys ?? [])];
  for (const f of files) {
    const match = f.originalname?.match(/^clip_(\d+)\.mp4$/);
    if (!match) continue;
    const idx = parseInt(match[1], 10);
    const dest = path.join(workspace, `clip_${idx}.mp4`);
    try {
      fs.renameSync(f.path, dest);
    } catch {
      fs.copyFileSync(f.path, dest);
      try {
        fs.unlinkSync(f.path);
      } catch {
        /* ignore */
      }
    }
    const key = await uploadProjectFile(userId, projectId, `clip_${idx}.mp4`, dest);
    if (key) clipKeys[idx] = key;
  }
  await updateProject(projectId, userId, { clipKeys });
  res.json({ ok: true, clipKeys: clipKeys.filter(Boolean) });
});

router.delete('/:projectId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const deleted = await deleteProject(projectId, userId);
  if (!deleted) return res.status(404).json({ error: 'Project not found' });
  return res.status(200).json({ deleted: true });
});

router.get('/:projectId/media/:fileName', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId, fileName } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!/^[a-z0-9_.-]+$/i.test(fileName)) return res.status(400).json({ error: 'Invalid file name' });
  const dir = getProjectOutputDir(projectId);
  const filePath = path.join(dir, fileName);
  if (!fs.existsSync(filePath) || !filePath.startsWith(dir)) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(filePath);
});

export default router;
