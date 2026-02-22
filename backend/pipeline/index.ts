import path from 'path';
import { spawn } from 'child_process';

export type RunShortOptions = {
  topic?: string;
  testMode?: boolean;
  reuseTemp?: boolean;
  runStep?: 1 | 2 | 3 | 4;
  /** When set, pipeline uses project workspace and output dirs */
  projectTempDir?: string;
  projectOutputDir?: string;
  /** Video format: short (~1 min), 5min, or 11min. Sets length, scene count, aspect ratio. */
  videoFormat?: 'short' | '5min' | '11min';
  /** Script generation: openai (GPT) or grok. Env SCRIPT_PROVIDER passed to child. */
  scriptProvider?: 'openai' | 'grok';
  /** Optional absolute path to background music for assembly (step 4). Sets env BACKGROUND_MUSIC_PATH. */
  backgroundMusicPath?: string;
  /** Start background music from this many seconds into the track (0 = from start). Sets env BACKGROUND_MUSIC_START_SEC. */
  backgroundMusicStartSec?: number;
};

export type RunShortResult = {
  topic: string;
  outputPath: string;
  youtubeMetaPath: string | null;
  status?: 'waiting_for_clips';
  requiredFiles?: string[];
};

export async function runShortPipeline(opts: RunShortOptions = {}): Promise<RunShortResult> {
  const env = { ...process.env };

  const tempDir = opts.projectTempDir ?? path.resolve(process.cwd(), 'temp');
  const outputDir = opts.projectOutputDir ?? path.resolve(process.cwd(), 'output');
  if (opts.projectTempDir) env.PROJECT_TEMP_DIR = opts.projectTempDir;
  if (opts.projectOutputDir) env.PROJECT_OUTPUT_DIR = opts.projectOutputDir;

  env.AUTO_CLEAR_TEMP = '1';
  if (opts.testMode !== undefined) {
    env.TEST_MODE = opts.testMode ? 'true' : 'false';
  }
  if (opts.reuseTemp !== undefined) {
    env.REUSE_TEMP = opts.reuseTemp ? 'true' : 'false';
  }
  if (opts.runStep !== undefined) {
    env.RUN_STEP = String(opts.runStep);
    if (opts.runStep === 4) env.REUSE_TEMP = '1';
  }
  if (opts.topic) {
    env.SHORT_TOPIC_OVERRIDE = opts.topic;
  }
  if (opts.videoFormat && ['short', '5min', '11min'].includes(opts.videoFormat)) {
    env.VIDEO_FORMAT = opts.videoFormat;
  }
  if (opts.scriptProvider && (opts.scriptProvider === 'openai' || opts.scriptProvider === 'grok')) {
    env.SCRIPT_PROVIDER = opts.scriptProvider;
  }
  if (opts.backgroundMusicPath) {
    env.BACKGROUND_MUSIC_PATH = opts.backgroundMusicPath;
  }
  if (opts.backgroundMusicStartSec != null && opts.backgroundMusicStartSec > 0) {
    env.BACKGROUND_MUSIC_START_SEC = String(opts.backgroundMusicStartSec);
  }
  env.CURSOR_DEBUG_LOG_PATH = path.resolve(process.cwd(), '.cursor', 'debug.log');

  const outputPath = path.join(outputDir, 'final_short.mp4');
  const youtubeMetaPath = path.join(outputDir, 'youtube_meta.json');
  const waitingFile = path.join(tempDir, 'waiting_for_clips.json');

  await new Promise<void>((resolve, reject) => {
    const child = spawn('node', ['automate_shorts.js'], {
      cwd: process.cwd(),
      env,
      stdio: ['ignore', 'inherit', 'inherit']
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`automate_shorts.js exited with code ${code}`));
    });
  });

  const fs = require('fs') as typeof import('fs');
  if (fs.existsSync(waitingFile)) {
    let requiredFiles: string[] = [];
    try {
      const data = JSON.parse(fs.readFileSync(waitingFile, 'utf-8'));
      if (Array.isArray(data.required)) requiredFiles = data.required;
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(waitingFile);
    } catch {
      /* ignore */
    }
    let topic = opts.topic ?? '';
    if (!topic) {
      try {
        const selectedPath = path.join(tempDir, 'selected_topic.txt');
        if (fs.existsSync(selectedPath)) {
          topic = fs.readFileSync(selectedPath, 'utf-8').trim();
        }
      } catch {
        /* ignore */
      }
    }
    return {
      topic,
      outputPath: '',
      youtubeMetaPath: null,
      status: 'waiting_for_clips',
      requiredFiles
    };
  }

  let topic = opts.topic ?? '';
  if (!topic) {
    try {
      const selectedPath = path.join(tempDir, 'selected_topic.txt');
      if (fs.existsSync(selectedPath)) {
        topic = fs.readFileSync(selectedPath, 'utf-8').trim();
      }
    } catch {
      /* ignore */
    }
  }

  return {
    topic,
    outputPath,
    youtubeMetaPath
  };
}

