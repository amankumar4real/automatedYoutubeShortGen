import { Router, Response } from 'express';
import path from 'path';
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { Readable } from 'stream';
import multer from 'multer';
import {
  createProject,
  listProjects,
  listProjectsPaginated,
  getProjectByProjectId,
  getAssetUrl,
  getProjectWorkspaceDir,
  getProjectOutputDir,
  updateProject,
  pushStageHistory,
  uploadProjectFile,
  deleteProject
} from '../projects';
import { getObjectJson } from '../r2';
import { runProjectPipeline, runProjectAfterScriptApproval, runProjectAssembly, regenerateProjectScript } from '../projectRunner';
import { authMiddleware, AuthRequest } from '../middleware';
import { logger } from '../logger';
import { config } from '../config';
import { suggestFreshTitles } from '../titleService';
import { getCompetitorIntelForUser } from '../userIntel';

const router = Router();

type DownloadTokenPayload = {
  userId: string;
  projectId: string;
  purpose: 'project_download';
};

function signDownloadToken(payload: DownloadTokenPayload): string {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: '5m' } as jwt.SignOptions);
}

function verifyDownloadToken(token: string): DownloadTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.jwt.secret) as DownloadTokenPayload;
    if (!decoded || decoded.purpose !== 'project_download') return null;
    return decoded;
  } catch {
    return null;
  }
}

router.get('/:projectId/download', async (req, res: Response) => {
  const { projectId } = req.params;
  const token = String(req.query.token || '');
  if (!token) return res.status(400).json({ error: 'token is required' });
  const payload = verifyDownloadToken(token);
  if (!payload || payload.projectId !== projectId) return res.status(401).json({ error: 'Invalid or expired download token' });

  const project = await getProjectByProjectId(projectId, payload.userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const fileName = `short_${projectId}.mp4`;
  const outputDir = getProjectOutputDir(projectId);
  const localFinalPath = path.join(outputDir, 'final_short.mp4');

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);

  if (fs.existsSync(localFinalPath)) {
    return res.sendFile(localFinalPath);
  }

  if (project.finalVideoKey) {
    const url = await getAssetUrl(project.finalVideoKey);
    if (!url) return res.status(404).json({ error: 'Final video not found' });
    const upstream = await fetch(url);
    if (!upstream.ok || !upstream.body) {
      return res.status(404).json({ error: 'Final video not found' });
    }
    Readable.fromWeb(upstream.body as any).pipe(res);
    return;
  }
  return res.status(404).json({ error: 'Final video not found' });
});

router.use(authMiddleware);

const upload = multer({ dest: path.join(config.workspaceRoot, 'temp', 'uploads') });

interface ScriptData {
  voiceover: string;
  scenes: Array<{ prompt: string; voiceover?: string; duration?: number }>;
}

async function loadProjectScriptData(projectId: string, project: { scriptKey?: string }): Promise<ScriptData | null> {
  const scriptPath = path.join(getProjectWorkspaceDir(projectId), 'script.json');
  const scriptPathExists = fs.existsSync(scriptPath);
  let script: ScriptData | null = null;

  // Prefer local workspace file when it exists (e.g. right after regenerate-script) so we always serve the latest.
  if (scriptPathExists) {
    try {
      script = JSON.parse(fs.readFileSync(scriptPath, 'utf-8')) as ScriptData;
    } catch {
      /* ignore */
    }
  }

  if (!script && project.scriptKey) {
    script = await getObjectJson<ScriptData>(project.scriptKey);
    if (!script) {
      try {
        const url = await getAssetUrl(project.scriptKey);
        if (url) {
          const resp = await fetch(url);
          if (resp.ok) script = (await resp.json()) as ScriptData;
        }
      } catch {
        /* ignore */
      }
    }
  }

  if (!script || typeof script.voiceover !== 'string' || !Array.isArray(script.scenes)) {
    return null;
  }
  return script;
}

router.post('/', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const body = req.body as {
    topic?: string;
    idempotencyKey?: string;
    developmentsContext?: string;
    videoFormat?: string;
    useCompetitorIntel?: boolean;
    useWebResearch?: boolean;
    scriptProvider?: string;
  };
  const topic = body.topic?.trim();
  if (!topic) return res.status(400).json({ error: 'topic is required' });

  const developmentsContext = body.developmentsContext?.trim() || undefined;
  const videoFormat = (body.videoFormat === '5min' || body.videoFormat === '11min') ? body.videoFormat : undefined;
  const useCompetitorIntel = !!body.useCompetitorIntel;
  const useWebResearch = !!body.useWebResearch;
  const scriptProvider = body.scriptProvider === 'grok' ? 'grok' as const : undefined;
  const idempotencyKey = body.idempotencyKey ?? (req.headers['idempotency-key'] as string | undefined);
  try {
    const { project, created } = await createProject(
      userId,
      topic,
      idempotencyKey,
      videoFormat,
      useCompetitorIntel,
      useWebResearch,
      scriptProvider
    );
    if (created) {
      (async () => {
        try {
          const competitorIntel = useCompetitorIntel ? await getCompetitorIntelForUser(userId) : null;
          await runProjectPipeline(
            userId,
            project.projectId,
            project.topic,
            false,
            developmentsContext,
            competitorIntel,
            useWebResearch
          );
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
    const hasPage = typeof req.query.page !== 'undefined' || typeof req.query.pageSize !== 'undefined';
    if (hasPage) {
      const page = parseInt(String(req.query.page ?? '1'), 10) || 1;
      const pageSize = parseInt(String(req.query.pageSize ?? '10'), 10) || 10;
      const paged = await listProjectsPaginated(userId, page, pageSize);
      const items = await Promise.all(
        paged.items.map(async (p) => ({
          projectId: p.projectId,
          topic: p.topic,
          status: p.status,
          currentStage: p.currentStage,
          updatedAt: p.updatedAt.toISOString(),
          finalVideoUrl: p.finalVideoKey ? await getAssetUrl(p.finalVideoKey) : null
        }))
      );
      return res.json({
        items,
        page: paged.page,
        pageSize: paged.pageSize,
        total: paged.total,
        totalPages: paged.totalPages
      });
    }
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
  const script = await loadProjectScriptData(projectId, project);
  if (!script) {
    return res.status(404).json({ error: 'Script not found' });
  }
  return res.json({ voiceover: script.voiceover, scenes: script.scenes });
});

router.get('/:projectId/download-token', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'assembly_done') return res.status(400).json({ error: 'Final video is not ready yet' });
  const token = signDownloadToken({ userId, projectId, purpose: 'project_download' });
  return res.json({ token, expiresInSeconds: 300 });
});

router.post('/:projectId/confirm-script', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'script_generated' || project.currentStage !== 'script') {
    return res.status(400).json({
      error: 'Project is not awaiting script confirmation.'
    });
  }

  await updateProject(projectId, userId, {
    currentStage: 'audio',
    errorMessage: undefined
  });
  await pushStageHistory(projectId, userId, {
    stage: 'script',
    status: 'approved',
    at: new Date().toISOString()
  });

  // Fire and forget to avoid long request durations.
  (async () => {
    try {
      await runProjectAfterScriptApproval(userId, projectId, false);
    } catch (err) {
      logger.error('Project continuation after script confirm failed', err, { projectId });
    }
  })();

  return res.json({ ok: true, projectId, status: 'script_generated', currentStage: 'audio' });
});

router.post('/:projectId/reject-script', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'script_generated' || project.currentStage !== 'script') {
    return res.status(400).json({
      error: 'Project is not awaiting script confirmation.'
    });
  }

  const updated = await updateProject(projectId, userId, {
    status: 'rejected',
    currentStage: 'script',
    errorMessage: 'Script rejected by user'
  });
  await pushStageHistory(projectId, userId, {
    stage: 'script',
    status: 'rejected',
    at: new Date().toISOString()
  });
  return res.json({
    ok: true,
    projectId,
    status: updated?.status ?? 'rejected'
  });
});

router.post('/:projectId/regenerate-script', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const body = (req.body || {}) as { remarks?: string };
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'script_generated' || project.currentStage !== 'script') {
    return res.status(400).json({ error: 'Project is not awaiting script decision.' });
  }
  try {
    await regenerateProjectScript(userId, projectId, typeof body.remarks === 'string' ? body.remarks : undefined);
    return res.json({ ok: true });
  } catch (err) {
    logger.error('Regenerate script failed', err as Error, { projectId });
    return res.status(500).json({ error: (err as Error).message });
  }
});

router.get('/:projectId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const [scriptUrl, finalVideoUrlR2, youtubeMetaUrlR2, audioUrlR2, segmentMapUrlR2, segmentAlignmentUrlR2] = await Promise.all([
    getAssetUrl(project.scriptKey),
    getAssetUrl(project.finalVideoKey),
    getAssetUrl(project.youtubeMetaKey),
    project.audioKeys?.[0] ? getAssetUrl(project.audioKeys[0]) : Promise.resolve(null),
    getAssetUrl(project.segmentMapKey),
    getAssetUrl(project.segmentAlignmentKey)
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
  const segmentMapUrl =
    segmentMapUrlR2 ??
    (fs.existsSync(path.join(outputDir, 'clip_segment_map.json'))
      ? `/api/projects/${projectId}/media/clip_segment_map.json`
      : null);
  const segmentAlignmentUrl =
    segmentAlignmentUrlR2 ??
    (fs.existsSync(path.join(outputDir, 'segment_alignment.json'))
      ? `/api/projects/${projectId}/media/segment_alignment.json`
      : null);
  const audioSegmentUrls = await Promise.all(
    (project.audioKeys ?? []).slice(1).map((k) => getAssetUrl(k))
  );

  res.json({
    projectId: project.projectId,
    topic: project.topic,
    status: project.status,
    currentStage: project.currentStage,
    stageHistory: project.stageHistory,
    scriptUrl,
    finalVideoUrl: finalVideoUrl ?? null,
    youtubeMetaUrl: youtubeMetaUrl ?? null,
    segmentMapUrl: segmentMapUrl ?? null,
    segmentAlignmentUrl: segmentAlignmentUrl ?? null,
    audioUrl: audioUrlR2,
    audioSegmentUrls: audioSegmentUrls.filter((u): u is string => !!u),
    requiredFiles: project.requiredFiles,
    errorMessage: project.errorMessage,
    videoFormat: project.videoFormat ?? 'short',
    backgroundMusicStartSec: project.backgroundMusicStartSec ?? 0,
    updatedAt: project.updatedAt.toISOString(),
    createdAt: project.createdAt.toISOString()
  });
});

async function loadProjectJsonAsset(
  projectId: string,
  r2Key: string | undefined,
  localFile: string
): Promise<Record<string, unknown> | null> {
  if (r2Key) {
    try {
      const url = await getAssetUrl(r2Key);
      if (url) {
        const resp = await fetch(url);
        if (resp.ok) return (await resp.json()) as Record<string, unknown>;
      }
    } catch {
      /* fall back to local file */
    }
  }
  const localPath = path.join(getProjectOutputDir(projectId), localFile);
  if (!fs.existsSync(localPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(localPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

router.get('/:projectId/segments', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const payload = await loadProjectJsonAsset(projectId, project.segmentMapKey, 'clip_segment_map.json');
  if (!payload) return res.status(404).json({ error: 'Segment map not found' });
  return res.json(payload);
});

router.get('/:projectId/segments/detailed', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });

  const [segmentMap, alignment] = await Promise.all([
    loadProjectJsonAsset(projectId, project.segmentMapKey, 'clip_segment_map.json'),
    loadProjectJsonAsset(projectId, project.segmentAlignmentKey, 'segment_alignment.json')
  ]);
  if (!segmentMap) return res.status(404).json({ error: 'Segment map not found' });

  const segmentRows = Array.isArray((segmentMap as { segments?: unknown[] }).segments)
    ? ((segmentMap as { segments?: unknown[] }).segments as Array<Record<string, unknown>>)
    : [];
  const rowsWithUrls = await Promise.all(segmentRows.map(async (row, idx) => {
    const clipIndex = typeof row.clipIndex === 'number' ? row.clipIndex : idx;
    const clipUrl = project.clipKeys?.[clipIndex] ? await getAssetUrl(project.clipKeys[clipIndex]) : null;
    const audioSegmentUrl = project.audioKeys?.[clipIndex + 1] ? await getAssetUrl(project.audioKeys[clipIndex + 1]) : null;
    return { ...row, clipUrl, audioSegmentUrl };
  }));

  return res.json({
    mode: segmentMap.mode ?? null,
    clipCount: segmentMap.clipCount ?? rowsWithUrls.length,
    audioDurationSec: segmentMap.audioDurationSec ?? null,
    segments: rowsWithUrls,
    alignment
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

router.post('/:projectId/titles/suggest', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'assembly_done') {
    return res.status(400).json({
      error: 'Title suggestions are available only when project is in assembly_done state.'
    });
  }

  try {
    const script = await loadProjectScriptData(projectId, project);
    if (!script) return res.status(404).json({ error: 'Script not found' });
    const titles = await suggestFreshTitles(project.topic, script, 15);
    return res.json({ titles });
  } catch (err) {
    return res.status(500).json({ error: (err as Error).message });
  }
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
  const imageKeys: string[] = [...(project.imageKeys ?? [])];
  let acceptedFiles = 0;
  for (const f of files) {
    const clipMatch = f.originalname?.match(/^clip_(\d+)\.mp4$/i);
    const imageMatch = f.originalname?.match(/^image_(\d+)\.(jpg|jpeg|png|webp)$/i);
    if (clipMatch) {
      acceptedFiles += 1;
      const idx = parseInt(clipMatch[1], 10);
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
    } else if (imageMatch) {
      acceptedFiles += 1;
      const idx = parseInt(imageMatch[1], 10);
      const ext = imageMatch[2].toLowerCase();
      const dest = path.join(workspace, `image_${idx}.${ext}`);
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
      const imageKey = await uploadProjectFile(userId, projectId, `image_${idx}.${ext}`, dest);
      if (imageKey) imageKeys[idx] = imageKey;
    }
  }
  if (acceptedFiles === 0) {
    return res.status(400).json({
      error: 'No valid files. Use clip_0.mp4, clip_1.mp4, … or image_0.jpg, image_1.png, … for photos/documents (zoom effect).'
    });
  }
  await updateProject(projectId, userId, { clipKeys, imageKeys: imageKeys.filter(Boolean).length ? imageKeys : undefined });
  res.json({ ok: true, clipKeys: clipKeys.filter(Boolean) });
});

router.post('/:projectId/background-music', upload.single('file'), async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (project.status !== 'waiting_for_clips') {
    return res.status(400).json({ error: 'Background music can only be set when project is waiting for clips.' });
  }
  const file = (req as { file?: Express.Multer.File }).file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const workspace = getProjectWorkspaceDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  const dest = path.join(workspace, 'background_music.mp3');
  try {
    fs.renameSync(file.path, dest);
  } catch {
    fs.copyFileSync(file.path, dest);
    try {
      fs.unlinkSync(file.path);
    } catch {
      /* ignore */
    }
  }
  const key = await uploadProjectFile(userId, projectId, 'background_music.mp3', dest);
  if (!key) return res.status(500).json({ error: 'Failed to store background music' });
  const startSecRaw = (req.body && typeof (req.body as { backgroundMusicStartSec?: unknown }).backgroundMusicStartSec !== 'undefined')
    ? (req.body as { backgroundMusicStartSec?: number }).backgroundMusicStartSec
    : undefined;
  const backgroundMusicStartSec = typeof startSecRaw === 'number' && !Number.isNaN(startSecRaw) && startSecRaw >= 0
    ? Math.round(startSecRaw)
    : undefined;
  await updateProject(projectId, userId, { backgroundMusicKey: key, ...(backgroundMusicStartSec !== undefined ? { backgroundMusicStartSec } : {}) });
  res.json({ ok: true, backgroundMusicKey: key, ...(backgroundMusicStartSec !== undefined ? { backgroundMusicStartSec } : {}) });
});

router.patch('/:projectId', async (req: AuthRequest, res: Response) => {
  const userId = req.user!.id;
  const { projectId } = req.params;
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const body = req.body as { backgroundMusicStartSec?: unknown };
  if (body.backgroundMusicStartSec !== undefined) {
    const n = typeof body.backgroundMusicStartSec === 'number' ? body.backgroundMusicStartSec : parseFloat(String(body.backgroundMusicStartSec));
    const backgroundMusicStartSec = !Number.isNaN(n) && n >= 0 ? Math.round(n) : 0;
    await updateProject(projectId, userId, { backgroundMusicStartSec });
  }
  const updated = await getProjectByProjectId(projectId, userId);
  return res.json(updated ?? project);
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
