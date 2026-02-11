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

