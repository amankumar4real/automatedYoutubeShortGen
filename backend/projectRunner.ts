import fs from 'fs';
import path from 'path';
import { runShortPipeline } from './pipeline/index';
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
import { ProjectDoc } from './db';

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
  testMode: boolean
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
    clipKeys: project.clipKeys
  });

  const runOpts = {
    topic,
    testMode,
    projectTempDir: workspace,
    projectOutputDir: outputDir
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
    clipKeys: project.clipKeys
  });

  try {
    const result = await runShortPipeline({
      topic: project.topic,
      projectTempDir: workspace,
      projectOutputDir: outputDir,
      runStep: 4,
      reuseTemp: true
    });

    const finalPath = path.join(outputDir, 'final_short.mp4');
    const metaPath = path.join(outputDir, 'youtube_meta.json');
    const finalKey = fs.existsSync(finalPath)
      ? await uploadProjectFile(userId, projectId, 'final_short.mp4', finalPath)
      : null;
    const metaKey = fs.existsSync(metaPath)
      ? await uploadProjectFile(userId, projectId, 'youtube_meta.json', metaPath)
      : null;

    await updateProject(projectId, userId, {
      status: 'assembly_done',
      currentStage: 'assembly',
      finalVideoKey: finalKey ?? undefined,
      youtubeMetaKey: metaKey ?? undefined,
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
