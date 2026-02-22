import { ObjectId } from 'mongodb';
import { nanoid } from 'nanoid';
import path from 'path';
import { getDb, ProjectDoc, StageEntry, PROJECTS_COLL } from './db';
import {
  isR2Enabled,
  projectKey,
  uploadFile,
  downloadToFile,
  getPresignedUrl,
  deleteProjectAssets
} from './r2';
import { config } from './config';

const TEMP_BASE = path.join(config.workspaceRoot, 'temp');
const OUTPUT_BASE = path.join(config.workspaceRoot, 'output');

/** Project workspace on disk: temp/projects/<projectId>/ */
export function getProjectWorkspaceDir(projectId: string): string {
  return path.join(TEMP_BASE, 'projects', projectId);
}

/** Output dir for a project (for final_short.mp4 etc.): output/projects/<projectId>/ */
export function getProjectOutputDir(projectId: string): string {
  return path.join(OUTPUT_BASE, 'projects', projectId);
}

export async function createProject(
  userId: string,
  topic: string,
  idempotencyKey?: string,
  videoFormat?: 'short' | '5min' | '11min',
  useCompetitorIntel?: boolean,
  useWebResearch?: boolean,
  scriptProvider?: 'openai' | 'grok'
): Promise<{ project: ProjectDoc; created: boolean }> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  const uid = new ObjectId(userId);
  if (idempotencyKey) {
    const existing = await coll.findOne({ userId: uid, idempotencyKey });
    if (existing) return { project: existing, created: false };
  }
  const projectId = nanoid();
  const now = new Date();
  const doc: ProjectDoc = {
    _id: new ObjectId(),
    projectId,
    userId: uid,
    topic: topic.trim(),
    idempotencyKey,
    status: 'draft',
    currentStage: undefined,
    stageHistory: [],
    scriptKey: undefined,
    audioKeys: undefined,
    clipKeys: undefined,
    finalVideoKey: undefined,
    youtubeMetaKey: undefined,
    segmentMapKey: undefined,
    segmentAlignmentKey: undefined,
    requiredFiles: undefined,
    errorMessage: undefined,
    videoFormat: videoFormat && ['short', '5min', '11min'].includes(videoFormat) ? videoFormat : undefined,
    useCompetitorIntel: !!useCompetitorIntel,
    useWebResearch: !!useWebResearch,
    scriptProvider: scriptProvider === 'grok' ? 'grok' : undefined,
    createdAt: now,
    updatedAt: now
  };
  await coll.insertOne(doc as ProjectDoc);
  return { project: doc, created: true };
}

export async function getProjectByProjectId(
  projectId: string,
  userId: string
): Promise<ProjectDoc | null> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  const byObjectId = await coll.findOne({ projectId, userId: new ObjectId(userId) });
  if (byObjectId) return byObjectId;
  if (!userId || !ObjectId.isValid(userId)) return null;
  const byProjectOnly = await coll.findOne({ projectId });
  if (byProjectOnly && byProjectOnly.userId && String(byProjectOnly.userId) === String(userId)) return byProjectOnly;
  return null;
}

export async function getProjectById(
  id: string,
  userId: string
): Promise<ProjectDoc | null> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  if (!ObjectId.isValid(id)) return null;
  return coll.findOne({ _id: new ObjectId(id), userId: new ObjectId(userId) });
}

export async function listProjects(userId: string): Promise<ProjectDoc[]> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  return coll
    .find({ userId: new ObjectId(userId) })
    .sort({ updatedAt: -1 })
    .limit(100)
    .toArray();
}

export async function listProjectsPaginated(
  userId: string,
  page: number,
  pageSize: number
): Promise<{ items: ProjectDoc[]; total: number; page: number; pageSize: number; totalPages: number }> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  const safePageSize = Math.max(1, Math.min(50, Math.floor(pageSize || 10)));
  const safePage = Math.max(1, Math.floor(page || 1));
  const query = { userId: new ObjectId(userId) };
  const total = await coll.countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / safePageSize));
  const pageClamped = Math.min(safePage, totalPages);
  const items = await coll
    .find(query)
    .sort({ updatedAt: -1 })
    .skip((pageClamped - 1) * safePageSize)
    .limit(safePageSize)
    .toArray();
  return {
    items,
    total,
    page: pageClamped,
    pageSize: safePageSize,
    totalPages
  };
}

export async function updateProject(
  projectId: string,
  userId: string,
  update: Partial<Pick<ProjectDoc, 'status' | 'currentStage' | 'stageHistory' | 'scriptKey' | 'audioKeys' | 'clipKeys' | 'imageKeys' | 'finalVideoKey' | 'youtubeMetaKey' | 'segmentMapKey' | 'segmentAlignmentKey' | 'backgroundMusicKey' | 'backgroundMusicStartSec' | 'requiredFiles' | 'errorMessage'>>
): Promise<ProjectDoc | null> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  const now = new Date();
  const result = await coll.findOneAndUpdate(
    { projectId, userId: new ObjectId(userId) },
    { $set: { ...update, updatedAt: now } },
    { returnDocument: 'after' }
  );
  return result ?? null;
}

export async function pushStageHistory(
  projectId: string,
  userId: string,
  entry: StageEntry
): Promise<void> {
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  await coll.updateOne(
    { projectId, userId: new ObjectId(userId) },
    {
      $push: { stageHistory: entry },
      $set: { updatedAt: new Date() }
    }
  );
}

// ——— Sync workspace ↔ R2 ———

/** Ensure local project workspace exists; download from R2 if enabled and keys exist. */
export async function syncR2ToWorkspace(projectId: string, userId: string, keys: {
  scriptKey?: string;
  audioKeys?: string[];
  clipKeys?: string[];
  imageKeys?: string[];
  segmentMapKey?: string;
  segmentAlignmentKey?: string;
  backgroundMusicKey?: string;
}): Promise<void> {
  const fs = await import('fs');
  const workspace = getProjectWorkspaceDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });

  if (!isR2Enabled()) return;

  if (keys.scriptKey) {
    const dest = path.join(workspace, 'script.json');
    await downloadToFile(keys.scriptKey, dest);
  }
  if (keys.audioKeys?.length) {
    const mainAudio = path.join(workspace, 'audio.mp3');
    if (keys.audioKeys[0]) await downloadToFile(keys.audioKeys[0], mainAudio);
    for (let i = 1; i < keys.audioKeys.length; i++) {
      const dest = path.join(workspace, `audio_scene_${i - 1}.mp3`);
      await downloadToFile(keys.audioKeys[i], dest);
    }
  }
  if (keys.clipKeys?.length) {
    for (let i = 0; i < keys.clipKeys.length; i++) {
      const dest = path.join(workspace, `clip_${i}.mp4`);
      await downloadToFile(keys.clipKeys[i], dest);
    }
  }
  if (keys.imageKeys?.length) {
    for (const key of keys.imageKeys.filter(Boolean)) {
      const fileName = (key as string).split('/').pop() || (key as string);
      const dest = path.join(workspace, fileName);
      await downloadToFile(key as string, dest);
    }
  }
  if (keys.segmentMapKey) {
    const outputDir = getProjectOutputDir(projectId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    await downloadToFile(keys.segmentMapKey, path.join(outputDir, 'clip_segment_map.json'));
  }
  if (keys.segmentAlignmentKey) {
    const outputDir = getProjectOutputDir(projectId);
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
    await downloadToFile(keys.segmentAlignmentKey, path.join(outputDir, 'segment_alignment.json'));
  }
  if (keys.backgroundMusicKey) {
    const dest = path.join(workspace, 'background_music.mp3');
    await downloadToFile(keys.backgroundMusicKey, dest);
  }
}

/** Upload a single file from workspace to R2 and return the key. */
export async function uploadProjectFile(
  userId: string,
  projectId: string,
  fileName: string,
  localPath: string
): Promise<string | null> {
  if (!isR2Enabled()) return null;
  const key = projectKey(userId, projectId, fileName);
  const result = await uploadFile(key, localPath);
  return result ? key : null;
}

/** Upload workspace artifacts to R2 and return keys to store in DB. */
export async function uploadWorkspaceToR2(
  userId: string,
  projectId: string,
  workspaceDir: string
): Promise<{
  scriptKey?: string;
  audioKeys?: string[];
  clipKeys?: string[];
  imageKeys?: string[];
 }> {
  const fs = await import('fs');
  const out: { scriptKey?: string; audioKeys?: string[]; clipKeys?: string[]; imageKeys?: string[] } = {};
  const scriptPath = path.join(workspaceDir, 'script.json');
  if (fs.existsSync(scriptPath)) {
    const k = await uploadProjectFile(userId, projectId, 'script.json', scriptPath);
    if (k) out.scriptKey = k;
  }
  const audioPath = path.join(workspaceDir, 'audio.mp3');
  const audioKeys: string[] = [];
  if (fs.existsSync(audioPath)) {
    const k = await uploadProjectFile(userId, projectId, 'audio.mp3', audioPath);
    if (k) audioKeys.push(k);
  }
  let audioSceneIndex = 0;
  while (fs.existsSync(path.join(workspaceDir, `audio_scene_${audioSceneIndex}.mp3`))) {
    const k = await uploadProjectFile(
      userId,
      projectId,
      `audio_scene_${audioSceneIndex}.mp3`,
      path.join(workspaceDir, `audio_scene_${audioSceneIndex}.mp3`)
    );
    if (k) audioKeys.push(k);
    audioSceneIndex += 1;
  }
  if (audioKeys.length) out.audioKeys = audioKeys;
  let i = 0;
  const clipKeys: string[] = [];
  while (fs.existsSync(path.join(workspaceDir, `clip_${i}.mp4`))) {
    const k = await uploadProjectFile(userId, projectId, `clip_${i}.mp4`, path.join(workspaceDir, `clip_${i}.mp4`));
    if (k) clipKeys.push(k);
    i++;
  }
  if (clipKeys.length) out.clipKeys = clipKeys;
  const imageKeys: string[] = [];
  const imageNames = fs.readdirSync(workspaceDir).filter((n) => /^image_\d+\.(jpg|jpeg|png|webp)$/i.test(n));
  imageNames.sort((a, b) => {
    const na = parseInt(a.replace(/^image_(\d+).*/, '$1'), 10);
    const nb = parseInt(b.replace(/^image_(\d+).*/, '$1'), 10);
    return na - nb;
  });
  for (const name of imageNames) {
    const k = await uploadProjectFile(userId, projectId, name, path.join(workspaceDir, name));
    if (k) imageKeys.push(k);
  }
  if (imageKeys.length) out.imageKeys = imageKeys;
  return out;
}

/** Get presigned URL for a stored key; if R2 disabled and key not set, return null. */
export async function getAssetUrl(key: string | undefined): Promise<string | null> {
  if (!key || !isR2Enabled()) return null;
  return getPresignedUrl(key);
}

/** Delete project: R2 assets then MongoDB doc. Returns deleted doc or null if not found/wrong user. */
export async function deleteProject(
  projectId: string,
  userId: string
): Promise<ProjectDoc | null> {
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) {
    return null;
  }
  await deleteProjectAssets(userId, projectId);
  const db = await getDb();
  const coll = db.collection<ProjectDoc>(PROJECTS_COLL);
  const result = await coll.findOneAndDelete({
    projectId,
    userId: new ObjectId(userId)
  });
  return result ?? null;
}
