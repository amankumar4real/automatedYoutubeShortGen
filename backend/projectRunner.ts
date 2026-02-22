import fs from 'fs';
import path from 'path';
import { runShortPipeline, type RunShortOptions } from './pipeline/index';
import {
  getProjectWorkspaceDir,
  getProjectOutputDir,
  syncR2ToWorkspace,
  uploadProjectFile,
  uploadWorkspaceToR2,
  updateProject,
  pushStageHistory,
  getProjectByProjectId
} from './projects';
import { CompetitorIntelSnapshot, ProjectDoc } from './db';
import { getWebResearchContext } from './webResearchService';

/** Fallback when fs.rmSync(..., { recursive: true }) fails (e.g. locked files). */
function rmDirRecursive(dir: string): void {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) rmDirRecursive(full);
    else fs.unlinkSync(full);
  }
  fs.rmdirSync(dir);
}

export async function runProjectPipeline(
  userId: string,
  projectId: string,
  topic: string,
  testMode: boolean,
  developmentsContext?: string,
  competitorIntel?: CompetitorIntelSnapshot | null,
  useWebResearch = false
): Promise<void> {
  const workspace = getProjectWorkspaceDir(projectId);
  const outputDir = getProjectOutputDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const project = await getProjectByProjectId(projectId, userId);
  if (!project) return;

  await syncR2ToWorkspace(projectId, userId, {
    scriptKey: project.scriptKey,
    audioKeys: project.audioKeys,
    clipKeys: project.clipKeys,
    imageKeys: project.imageKeys,
    segmentMapKey: project.segmentMapKey,
    segmentAlignmentKey: project.segmentAlignmentKey
  });

  const contextBlocks: string[] = [];
  if (developmentsContext && developmentsContext.trim()) {
    contextBlocks.push(developmentsContext.trim());
  }
  if (useWebResearch) {
    try {
      const webContext = await getWebResearchContext(topic, 6);
      if (webContext.trim()) contextBlocks.push(webContext.trim());
    } catch {
      /* optional enrichment; ignore failures */
    }
  }
  if (contextBlocks.length > 0) {
    fs.writeFileSync(path.join(workspace, 'current_developments_raw.txt'), contextBlocks.join('\n\n'), 'utf-8');
  }
  if (project.useCompetitorIntel && competitorIntel) {
    const compact = {
      updatedAt: competitorIntel.updatedAt,
      topTopics: competitorIntel.insights.topTopics ?? [],
      titlePatterns: competitorIntel.insights.titlePatterns ?? [],
      postingPatterns: competitorIntel.insights.postingPatterns ?? [],
      opportunities: competitorIntel.insights.opportunities ?? [],
      shortSuggestions: competitorIntel.insights.shortSuggestions ?? [],
      longVideoSuggestions: competitorIntel.insights.longVideoSuggestions ?? []
    };
    fs.writeFileSync(
      path.join(workspace, 'competitor_intel_raw.txt'),
      JSON.stringify(compact, null, 2),
      'utf-8'
    );
  }

  const videoFormat: RunShortOptions['videoFormat'] =
    (project.videoFormat === '5min' || project.videoFormat === '11min') ? project.videoFormat : 'short';

  const runOpts: Omit<RunShortOptions, 'runStep' | 'reuseTemp'> & {
    topic: string;
    projectTempDir: string;
    projectOutputDir: string;
  } = {
    topic,
    testMode,
    projectTempDir: workspace,
    projectOutputDir: outputDir,
    videoFormat,
    ...(project.scriptProvider === 'grok' ? { scriptProvider: 'grok' as const } : {})
  };

  // Step 1: script
  try {
    await runShortPipeline({ ...runOpts, runStep: 1, reuseTemp: false });
  } catch (err) {
    await updateProject(projectId, userId, {
      status: 'error',
      currentStage: 'script',
      errorMessage: (err as Error).message
    });
    await pushStageHistory(projectId, userId, {
      stage: 'script',
      status: 'error',
      at: new Date().toISOString(),
      detail: (err as Error).message
    });
    throw err;
  }

  const scriptPath = path.join(workspace, 'script.json');
  if (fs.existsSync(scriptPath)) {
    const key = await uploadProjectFile(userId, projectId, 'script.json', scriptPath);
    await updateProject(projectId, userId, {
      status: 'script_generated',
      currentStage: 'script',
      scriptKey: key ?? undefined
    });
    await pushStageHistory(projectId, userId, {
      stage: 'script',
      status: 'done',
      at: new Date().toISOString()
    });
  }

  // Stop after script generation and wait for explicit confirmation from UI.
  return;
}

/**
 * Regenerate script and prompts for a project that is in script_generated / script stage.
 * Optionally appends remarks to developments context so the new script can take them into account.
 */
export async function regenerateProjectScript(
  userId: string,
  projectId: string,
  remarks?: string
): Promise<void> {
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) throw new Error('Project not found');
  if (project.status !== 'script_generated' || project.currentStage !== 'script') {
    throw new Error('Project is not awaiting script decision');
  }

  const workspace = getProjectWorkspaceDir(projectId);
  const outputDir = getProjectOutputDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  await syncR2ToWorkspace(projectId, userId, {
    scriptKey: project.scriptKey,
    audioKeys: project.audioKeys,
    clipKeys: project.clipKeys,
    imageKeys: project.imageKeys,
    segmentMapKey: project.segmentMapKey,
    segmentAlignmentKey: project.segmentAlignmentKey
  });

  if (remarks && remarks.trim()) {
    const rawPath = path.join(workspace, 'current_developments_raw.txt');
    const existing = fs.existsSync(rawPath)
      ? fs.readFileSync(rawPath, 'utf-8').trim()
      : '';
    const appended = existing
      ? `${existing}\n\nUSER REMARKS (use to refine the script):\n${remarks.trim()}`
      : `USER REMARKS (use to refine the script):\n${remarks.trim()}`;
    fs.writeFileSync(rawPath, appended, 'utf-8');
  }

  const scriptPath = path.join(workspace, 'script.json');
  if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

  const videoFormat: RunShortOptions['videoFormat'] =
    (project.videoFormat === '5min' || project.videoFormat === '11min') ? project.videoFormat : 'short';

  const runOpts: Omit<RunShortOptions, 'runStep' | 'reuseTemp'> & {
    topic: string;
    projectTempDir: string;
    projectOutputDir: string;
  } = {
    topic: project.topic,
    testMode: false,
    projectTempDir: workspace,
    projectOutputDir: outputDir,
    videoFormat,
    ...(project.scriptProvider === 'grok' ? { scriptProvider: 'grok' as const } : {})
  };

  try {
    await runShortPipeline({ ...runOpts, runStep: 1, reuseTemp: true });
  } catch (err) {
    await updateProject(projectId, userId, {
      status: 'error',
      currentStage: 'script',
      errorMessage: (err as Error).message
    });
    await pushStageHistory(projectId, userId, {
      stage: 'script',
      status: 'error',
      at: new Date().toISOString(),
      detail: (err as Error).message
    });
    throw err;
  }

  if (fs.existsSync(scriptPath)) {
    const key = await uploadProjectFile(userId, projectId, 'script.json', scriptPath);
    await updateProject(projectId, userId, {
      status: 'script_generated',
      currentStage: 'script',
      scriptKey: key ?? undefined
    });
    await pushStageHistory(projectId, userId, {
      stage: 'script',
      status: 'done',
      at: new Date().toISOString()
    });
  }
}

export async function runProjectAfterScriptApproval(
  userId: string,
  projectId: string,
  testMode = false
): Promise<void> {
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) throw new Error('Project not found');
  if (project.status !== 'script_generated') {
    throw new Error('Project is not in script_generated state');
  }
  if (project.currentStage !== 'audio') {
    throw new Error('Project is not confirmed for audio generation');
  }

  const workspace = getProjectWorkspaceDir(projectId);
  const outputDir = getProjectOutputDir(projectId);
  if (!fs.existsSync(workspace)) fs.mkdirSync(workspace, { recursive: true });
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  await syncR2ToWorkspace(projectId, userId, {
    scriptKey: project.scriptKey,
    audioKeys: project.audioKeys,
    clipKeys: project.clipKeys,
    imageKeys: project.imageKeys,
    segmentMapKey: project.segmentMapKey,
    segmentAlignmentKey: project.segmentAlignmentKey
  });

  const videoFormat: RunShortOptions['videoFormat'] =
    (project.videoFormat === '5min' || project.videoFormat === '11min') ? project.videoFormat : 'short';

  const runOpts: Omit<RunShortOptions, 'runStep' | 'reuseTemp'> & {
    topic: string;
    projectTempDir: string;
    projectOutputDir: string;
  } = {
    topic: project.topic,
    testMode,
    projectTempDir: workspace,
    projectOutputDir: outputDir,
    videoFormat
  };

  // Step 2: audio
  try {
    await runShortPipeline({ ...runOpts, runStep: 2, reuseTemp: true });
  } catch (err) {
    await updateProject(projectId, userId, {
      status: 'error',
      currentStage: 'audio',
      errorMessage: (err as Error).message
    });
    await pushStageHistory(projectId, userId, {
      stage: 'audio',
      status: 'error',
      at: new Date().toISOString(),
      detail: (err as Error).message
    });
    throw err;
  }

  const uploaded = await uploadWorkspaceToR2(userId, projectId, workspace);
  await updateProject(projectId, userId, {
    status: 'audio_generated',
    currentStage: 'audio',
    audioKeys: uploaded.audioKeys
  });
  await pushStageHistory(projectId, userId, {
    stage: 'audio',
    status: 'done',
    at: new Date().toISOString()
  });

  // Step 3: clips (may exit with waiting_for_clips)
  try {
    const result = await runShortPipeline({ ...runOpts, runStep: 3, reuseTemp: true });
    if (result.status === 'waiting_for_clips') {
      await updateProject(projectId, userId, {
        status: 'waiting_for_clips',
        currentStage: 'clips',
        requiredFiles: result.requiredFiles
      });
      await pushStageHistory(projectId, userId, {
        stage: 'clips',
        status: 'waiting_for_clips',
        at: new Date().toISOString(),
        detail: result.requiredFiles?.join(', ')
      });
      return;
    }
  } catch (err) {
    await updateProject(projectId, userId, {
      status: 'error',
      currentStage: 'clips',
      errorMessage: (err as Error).message
    });
    await pushStageHistory(projectId, userId, {
      stage: 'clips',
      status: 'error',
      at: new Date().toISOString(),
      detail: (err as Error).message
    });
    throw err;
  }

  // All clips present: upload clips to R2, then run assembly (step 4)
  const clipUploads = await uploadWorkspaceToR2(userId, projectId, workspace);
  if (clipUploads.clipKeys?.length) {
    await updateProject(projectId, userId, { clipKeys: clipUploads.clipKeys });
  }
  await runProjectAssembly(userId, projectId);
}

export async function runProjectAssembly(userId: string, projectId: string): Promise<void> {
  const project = await getProjectByProjectId(projectId, userId);
  if (!project) throw new Error('Project not found');
  if (project.status !== 'waiting_for_clips') {
    throw new Error('Project is not waiting for clips. Only projects with status waiting_for_clips can be continued.');
  }

  const workspace = getProjectWorkspaceDir(projectId);
  const outputDir = getProjectOutputDir(projectId);
  await syncR2ToWorkspace(projectId, userId, {
    scriptKey: project.scriptKey,
    audioKeys: project.audioKeys,
    clipKeys: project.clipKeys,
    imageKeys: project.imageKeys,
    segmentMapKey: project.segmentMapKey,
    segmentAlignmentKey: project.segmentAlignmentKey,
    backgroundMusicKey: project.backgroundMusicKey
  });

  try {
    const result = await runShortPipeline({
      topic: project.topic,
      projectTempDir: workspace,
      projectOutputDir: outputDir,
      runStep: 4,
      reuseTemp: true,
      videoFormat: (project.videoFormat === '5min' || project.videoFormat === '11min') ? project.videoFormat : 'short',
      ...(project.backgroundMusicKey ? { backgroundMusicPath: path.join(workspace, 'background_music.mp3'), backgroundMusicStartSec: project.backgroundMusicStartSec } : {})
    });

    const finalPath = path.join(outputDir, 'final_short.mp4');
    const metaPath = path.join(outputDir, 'youtube_meta.json');
    const segmentMapPath = path.join(outputDir, 'clip_segment_map.json');
    const segmentAlignmentPath = path.join(outputDir, 'segment_alignment.json');
    const finalKey = fs.existsSync(finalPath)
      ? await uploadProjectFile(userId, projectId, 'final_short.mp4', finalPath)
      : null;
    const metaKey = fs.existsSync(metaPath)
      ? await uploadProjectFile(userId, projectId, 'youtube_meta.json', metaPath)
      : null;
    const segmentMapKey = fs.existsSync(segmentMapPath)
      ? await uploadProjectFile(userId, projectId, 'clip_segment_map.json', segmentMapPath)
      : null;
    const segmentAlignmentKey = fs.existsSync(segmentAlignmentPath)
      ? await uploadProjectFile(userId, projectId, 'segment_alignment.json', segmentAlignmentPath)
      : null;
    const workspaceUploads = await uploadWorkspaceToR2(userId, projectId, workspace);

    await updateProject(projectId, userId, {
      status: 'assembly_done',
      currentStage: 'assembly',
      finalVideoKey: finalKey ?? undefined,
      youtubeMetaKey: metaKey ?? undefined,
      segmentMapKey: segmentMapKey ?? undefined,
      segmentAlignmentKey: segmentAlignmentKey ?? undefined,
      audioKeys: workspaceUploads.audioKeys ?? project.audioKeys,
      requiredFiles: undefined,
      errorMessage: undefined
    });
    await pushStageHistory(projectId, userId, {
      stage: 'assembly',
      status: 'done',
      at: new Date().toISOString()
    });

    // After successful assembly, workspace/output on disk are temporary only.
    // All durable artifacts live in R2 (keys stored in MongoDB).
    const dirsToRemove = [
      getProjectWorkspaceDir(projectId),
      getProjectOutputDir(projectId)
    ];
    for (const dir of dirsToRemove) {
      if (!fs.existsSync(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch (e) {
        try {
          rmDirRecursive(dir);
        } catch (e2) {
          // eslint-disable-next-line no-console
          console.warn('[projectRunner] Cleanup failed for', dir, (e2 as Error).message);
        }
      }
    }
  } catch (err) {
    const message = (err as Error).message || '';
    if (message.startsWith('ALIGNMENT_BLOCKED:')) {
      let payload: { reasons?: string[]; requiredFiles?: string[] } = {};
      try {
        payload = JSON.parse(message.slice('ALIGNMENT_BLOCKED:'.length)) as { reasons?: string[]; requiredFiles?: string[] };
      } catch {
        payload = {};
      }
      await updateProject(projectId, userId, {
        status: 'waiting_for_clips',
        currentStage: 'clips',
        requiredFiles: payload.requiredFiles ?? project.requiredFiles,
        errorMessage: payload.reasons?.join(', ') ?? 'alignment_blocked'
      });
      await pushStageHistory(projectId, userId, {
        stage: 'assembly',
        status: 'waiting_for_clips',
        at: new Date().toISOString(),
        detail: payload.reasons?.join(', ') ?? 'alignment_blocked'
      });
      return;
    }
    await updateProject(projectId, userId, {
      status: 'error',
      currentStage: 'assembly',
      errorMessage: (err as Error).message
    });
    await pushStageHistory(projectId, userId, {
      stage: 'assembly',
      status: 'error',
      at: new Date().toISOString(),
      detail: (err as Error).message
    });
    throw err;
  }
}
