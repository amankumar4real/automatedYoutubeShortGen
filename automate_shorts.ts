import 'dotenv/config';
import axios from 'axios';
import OpenAI from 'openai'; // or GoogleGenerativeAI for Gemini
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const readline = require('readline') as typeof import('readline');
import { ElevenLabsClient } from 'elevenlabs';
const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

// CONFIG (test mode disabled — always full pipeline)
const TEST_MODE = false;
const REUSE_TEMP = false; // set true to skip API calls when script/audio/clips already exist
const MANUAL_GROK = true; // true = no xAI API; you create clips in Grok terminal and put them in temp/
const BACKGROUND_MUSIC_PATH = process.env.BACKGROUND_MUSIC_PATH || 'temp/background_music.mp3'; // optional; fade in/out applied
const RUN_STEP = process.env.RUN_STEP ? parseInt(process.env.RUN_STEP, 10) : null; // 1=script only, 2=voiceover only, 3=clips/prompts only, 4=assembly only; unset = all 4
const XAI_API_KEY = process.env.XAI_API_KEY;
const ELEVEN_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// Clip length is fixed: 6s or 10s only (your generator constraint). Drives scene duration and voiceover length.
const TARGET_CLIP_SECONDS = (() => {
  const raw = process.env.TARGET_CLIP_SECONDS ?? '10';
  const n = parseInt(raw, 10);
  if (n === 6 || n === 10) return n;
  console.warn(`[MAIN] TARGET_CLIP_SECONDS must be 6 or 10 (got ${raw}). Using 10.`);
  return 10;
})();
const SCENE_DURATION_DEFAULT = TARGET_CLIP_SECONDS;

function log(step: string, message: string) {
  console.log(`[${step}] ${message}`);
}

const STEP_BANNER = '────────────────────────────────────────';
function stepBanner(stepNum: number, title: string) {
  console.log('');
  console.log(`${STEP_BANNER}  STEP ${stepNum}: ${title}  ${STEP_BANNER}`);
  console.log('');
}

function waitForEnter(message: string): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(message, () => {
      rl.close();
      resolve();
    });
  });
}

const TEMP_DIR = process.env.PROJECT_TEMP_DIR
  ? path.resolve(process.env.PROJECT_TEMP_DIR)
  : path.resolve(process.cwd(), 'temp');
const OUTPUT_DIR = process.env.PROJECT_OUTPUT_DIR
  ? path.resolve(process.env.PROJECT_OUTPUT_DIR)
  : path.resolve(process.cwd(), 'output');

function hasExistingProjectData(): boolean {
  if (!fs.existsSync(TEMP_DIR)) return false;
  const scriptPath = path.join(TEMP_DIR, 'script.json');
  const audioPath = path.join(TEMP_DIR, 'audio.mp3');
  const promptsPath = path.join(TEMP_DIR, 'clip_prompts.json');
  if (fs.existsSync(scriptPath) || fs.existsSync(audioPath) || fs.existsSync(promptsPath)) return true;
  try {
    const names = fs.readdirSync(TEMP_DIR);
    if (names.some((n) => n.startsWith('clip_') && n.endsWith('.mp4'))) return true;
  } catch {
    /* ignore */
  }
  return false;
}

function savePreviousOutputAndClearTemp(): void {
  const finalPath = path.join(OUTPUT_DIR, 'final_short.mp4');
  if (fs.existsSync(finalPath)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const savedName = `final_short_${stamp}.mp4`;
    const savedPath = path.join(OUTPUT_DIR, savedName);
    fs.renameSync(finalPath, savedPath);
    log('MAIN', `Saved previous video as output/${savedName}`);
  }
  const toRemove = [
    path.join(TEMP_DIR, 'script.json'),
    path.join(TEMP_DIR, 'audio.mp3'),
    path.join(TEMP_DIR, 'clip_prompts.json'),
    path.join(TEMP_DIR, 'clip_prompts.txt'),
    path.join(TEMP_DIR, 'files.txt')
  ];
  toRemove.forEach((p) => {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      log('MAIN', `Removed ${path.basename(p)}`);
    }
  });
  try {
    const names = fs.readdirSync(TEMP_DIR);
    names.filter((n) => n.startsWith('clip_') && n.endsWith('.mp4')).forEach((n) => {
      fs.unlinkSync(path.join(TEMP_DIR, n));
      log('MAIN', `Removed ${n}`);
    });
    names.filter((n) => n.startsWith('trimmed_') && n.endsWith('.mp4')).forEach((n) => {
      fs.unlinkSync(path.join(TEMP_DIR, n));
      log('MAIN', `Removed ${n}`);
    });
  } catch {
    /* ignore */
  }
  log('MAIN', 'Temp cleared. Starting new short.');
}

function getAudioDurationSeconds(audioPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(audioPath, (err, data) => {
      if (err) return reject(err);
      const dur = data?.format?.duration;
      resolve(typeof dur === 'number' && dur > 0 ? dur : 0);
    });
  });
}

function getVideoDurationSeconds(videoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) return reject(err);
      const dur = data?.format?.duration;
      resolve(typeof dur === 'number' && dur > 0 ? dur : 0);
    });
  });
}

// SCENE_DURATION_DEFAULT is set from TARGET_CLIP_SECONDS above (6 or 10)

type ClipSegment = {
  clipIndex: number;
  text: string;
  durationSec: number;
  startSec: number;
  endSec: number;
  source: 'scene-driven' | 'clip-driven';
  sourceClipDurationSec?: number;
};

type ClipSegmentMap = {
  mode: 'scene-driven' | 'clip-driven';
  clipCount: number;
  audioDurationSec: number;
  segments: ClipSegment[];
};

type SegmentAlignmentCheck = {
  coverageRatio: number;
  durationDeltaSec: number;
  emptySegmentCount: number;
  availableClipCount: number;
  requiredClipCount: number;
  maxStretchRatio: number;
  /** Segment index that had max stretch (for clip-driven block message). */
  stretchSegmentIndex?: number;
};

type SegmentAlignmentReport = {
  mode: 'scene-driven' | 'clip-driven';
  passed: boolean;
  reasons: string[];
  checks: SegmentAlignmentCheck;
  segments: ClipSegment[];
};

function getContiguousClipIndices(tempDir: string): number[] {
  const indices: number[] = [];
  let i = 0;
  while (fs.existsSync(path.join(tempDir, `clip_${i}.mp4`))) {
    indices.push(i);
    i += 1;
  }
  return indices;
}

function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return [];
  const chunks = normalized
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (chunks.length > 0) return chunks;
  return [normalized];
}

function splitTextEvenlyByWords(text: string, count: number): string[] {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return Array.from({ length: count }, () => '');
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < count; i++) {
    const remainingWords = words.length - cursor;
    const remainingSlots = count - i;
    const take = Math.max(1, Math.ceil(remainingWords / remainingSlots));
    out.push(words.slice(cursor, cursor + take).join(' '));
    cursor += take;
  }
  return out;
}

function splitVoiceoverByClipCount(voiceover: string, clipCount: number): string[] {
  if (clipCount <= 0) return [];
  const sentences = splitSentences(voiceover);
  if (sentences.length === 0) return Array.from({ length: clipCount }, () => '');
  if (sentences.length <= clipCount) {
    const byWords = splitTextEvenlyByWords(voiceover, clipCount);
    return byWords.map((seg) => seg.trim());
  }
  const sentenceWeights = sentences.map((s) => s.trim().split(/\s+/).filter(Boolean).length);
  const totalWeight = sentenceWeights.reduce((sum, w) => sum + w, 0);
  const targetWeight = Math.max(1, totalWeight / clipCount);
  const segments: string[] = [];
  let cursor = 0;
  let runningWeight = 0;
  for (let i = 0; i < clipCount; i++) {
    const start = cursor;
    const remainingSegments = clipCount - i;
    const remainingSentences = sentences.length - cursor;
    if (i === clipCount - 1) {
      segments.push(sentences.slice(cursor).join(' ').trim());
      break;
    }
    runningWeight = 0;
    while (cursor < sentences.length) {
      const stillNeededForOthers = (sentences.length - (cursor + 1)) >= (remainingSegments - 1);
      const nextWeight = sentenceWeights[cursor];
      const projected = runningWeight + nextWeight;
      if (runningWeight > 0 && projected > targetWeight && stillNeededForOthers) {
        break;
      }
      runningWeight = projected;
      cursor += 1;
      if (!stillNeededForOthers) break;
      const nearTarget = runningWeight >= targetWeight * 0.85;
      if (nearTarget) break;
    }
    if (cursor === start) cursor += 1;
    segments.push(sentences.slice(start, cursor).join(' ').trim());
    if (remainingSentences <= remainingSegments) {
      while (segments.length < clipCount && cursor < sentences.length) {
        segments.push(sentences[cursor]);
        cursor += 1;
      }
      break;
    }
  }
  if (segments.length < clipCount) {
    const joined = segments.join(' ').trim();
    return splitTextEvenlyByWords(joined, clipCount).map((seg) => seg.trim());
  }
  if (segments.length > clipCount) {
    const head = segments.slice(0, clipCount - 1);
    head.push(segments.slice(clipCount - 1).join(' ').trim());
    return head;
  }
  return segments;
}

function distributeDurationsByWeight(totalSec: number, weights: number[]): number[] {
  if (!Number.isFinite(totalSec) || totalSec <= 0 || weights.length === 0) return [];
  const safeWeights = weights.map((w) => (Number.isFinite(w) && w > 0 ? w : 1));
  const weightSum = safeWeights.reduce((sum, w) => sum + w, 0);
  const raw = safeWeights.map((w) => (w / weightSum) * totalSec);
  const rounded = raw.map((v) => Math.max(0.1, Number(v.toFixed(3))));
  const roundedSum = rounded.reduce((sum, v) => sum + v, 0);
  const correction = Number((totalSec - roundedSum).toFixed(3));
  rounded[rounded.length - 1] = Math.max(0.1, Number((rounded[rounded.length - 1] + correction).toFixed(3)));
  return rounded;
}

function withTimeline(
  segments: Array<{ clipIndex: number; text: string; durationSec: number; source: 'scene-driven' | 'clip-driven'; sourceClipDurationSec?: number }>
): ClipSegment[] {
  let cursor = 0;
  return segments.map((seg) => {
    const startSec = Number(cursor.toFixed(3));
    cursor += seg.durationSec;
    const endSec = Number(cursor.toFixed(3));
    return {
      clipIndex: seg.clipIndex,
      text: seg.text,
      durationSec: Number(seg.durationSec.toFixed(3)),
      startSec,
      endSec,
      source: seg.source,
      sourceClipDurationSec: seg.sourceClipDurationSec
    };
  });
}

function normalizeForCoverage(text: string): string {
  return text.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

function computeCoverageRatio(fullText: string, segmentTexts: string[]): number {
  const full = normalizeForCoverage(fullText);
  const joined = normalizeForCoverage(segmentTexts.join(' '));
  if (!full) return 1;
  return Math.min(1, joined.length / full.length);
}

function writeSegmentMap(outputDir: string, map: ClipSegmentMap): void {
  const segmentMapPath = path.join(outputDir, 'clip_segment_map.json');
  fs.writeFileSync(segmentMapPath, JSON.stringify(map, null, 2));
}

function writeSegmentAlignment(outputDir: string, report: SegmentAlignmentReport): void {
  const alignmentPath = path.join(outputDir, 'segment_alignment.json');
  fs.writeFileSync(alignmentPath, JSON.stringify(report, null, 2));
}

function buildAlignmentChecks(
  mode: 'scene-driven' | 'clip-driven',
  scriptVoiceover: string,
  segments: ClipSegment[],
  mergedAudioSec: number,
  availableClipCount: number,
  requiredClipCount: number
): SegmentAlignmentReport {
  const sumDur = segments.reduce((sum, s) => sum + s.durationSec, 0);
  const emptySegmentCount = segments.filter((s) => !s.text.trim()).length;
  const stretchRatios = segments.map((s) => {
    const base = s.sourceClipDurationSec && s.sourceClipDurationSec > 0 ? s.sourceClipDurationSec : s.durationSec;
    return base > 0 ? s.durationSec / base : 1;
  });
  const maxStretchRatioVal = Math.max(1, ...stretchRatios);
  const stretchSegmentIndex = stretchRatios.findIndex((r) => r === maxStretchRatioVal);
  const checks: SegmentAlignmentCheck = {
    coverageRatio: Number(computeCoverageRatio(scriptVoiceover, segments.map((s) => s.text)).toFixed(4)),
    durationDeltaSec: Number(Math.abs(sumDur - mergedAudioSec).toFixed(4)),
    emptySegmentCount,
    availableClipCount,
    requiredClipCount,
    maxStretchRatio: Number(maxStretchRatioVal.toFixed(4)),
    ...(mode === 'clip-driven' && stretchSegmentIndex >= 0 ? { stretchSegmentIndex } : undefined)
  };
  const reasons: string[] = [];
  if (mode === 'clip-driven' && checks.coverageRatio < 0.98) reasons.push('coverage_below_threshold');
  if (checks.durationDeltaSec > 0.35) reasons.push('duration_delta_too_high');
  if (checks.emptySegmentCount > 0) reasons.push('empty_segment_text');
  // In scene-lock we skip stretch check (semantic mapping is correct; slow-mo acceptable).
  if (mode === 'clip-driven' && checks.maxStretchRatio > 1.8) {
    reasons.push(
      stretchSegmentIndex >= 0
        ? `stretch_ratio_too_high segment_${stretchSegmentIndex}_ratio_${checks.maxStretchRatio}`
        : 'stretch_ratio_too_high'
    );
  }
  if (mode === 'clip-driven' && checks.availableClipCount < checks.requiredClipCount) {
    reasons.push('insufficient_clip_count_for_context');
  }
  return {
    mode,
    passed: reasons.length === 0,
    reasons,
    checks,
    segments
  };
}

function ensureAlignmentOrBlock(
  report: SegmentAlignmentReport,
  outputDir: string,
  scenesLength: number
): void {
  writeSegmentAlignment(outputDir, report);
  if (report.passed) return;
  const primaryReason = report.reasons[0] ?? 'alignment_check_failed';
  let hint: string | undefined;
  if (report.mode === 'clip-driven') {
    if (primaryReason.startsWith('stretch_ratio_too_high') || primaryReason.includes('stretch')) {
      hint = 'Upload one more clip so clip count matches scene count, or use shorter narration per clip.';
    } else if (primaryReason === 'coverage_below_threshold') {
      hint = 'Upload one more clip so clip count matches scene count, or use shorter narration per clip.';
    } else if (primaryReason === 'insufficient_clip_count_for_context') {
      hint = `Upload ${report.checks.requiredClipCount - report.checks.availableClipCount} more clip(s) so clip count matches scene count (${report.checks.requiredClipCount} scenes).`;
    } else if (primaryReason === 'empty_segment_text') {
      hint = 'Ensure every scene has voiceover text, or upload clips that match scene count.';
    }
  }
  const payload = {
    reason: primaryReason,
    reasons: report.reasons,
    ...(hint ? { hint } : undefined),
    requiredFiles: Array.from({ length: Math.max(scenesLength, report.checks.requiredClipCount) }, (_, i) => `clip_${i}.mp4`)
  };
  throw new Error(`ALIGNMENT_BLOCKED:${JSON.stringify(payload)}`);
}

async function writeAudioFromGeneratedStream(audioPath: string, audioStream: unknown): Promise<void> {
  const audioFile = fs.createWriteStream(audioPath);
  if (typeof (audioStream as { pipe?: unknown }).pipe === 'function') {
    await new Promise<void>((resolve, reject) => {
      (audioStream as NodeJS.ReadableStream).pipe(audioFile);
      audioFile.on('finish', () => resolve());
      audioFile.on('error', reject);
    });
    return;
  }
  const reader = (audioStream as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      audioFile.write(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  audioFile.end();
  await new Promise<void>((resolve, reject) => {
    audioFile.on('finish', () => resolve());
    audioFile.on('error', reject);
  });
}

async function concatAudioFiles(audioFiles: string[], outputPath: string): Promise<void> {
  const listPath = path.join(path.dirname(outputPath), 'audio_files.txt');
  const listContent = audioFiles.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n');
  fs.writeFileSync(listPath, listContent);
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f concat', '-safe 0'])
      .outputOptions(['-c copy'])
      .save(outputPath)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err));
  });
}

async function regenerateSegmentAudio(
  tempDir: string,
  segments: ClipSegment[]
): Promise<ClipSegment[]> {
  validateApiKeysForStep('audio');
  const segmentAudioPaths: string[] = [];
  const measuredDurations: number[] = [];
  const runSegment = async (i: number): Promise<void> => {
    const rawText = segments[i].text.trim();
    const text = rawText || '.'; // Empty segment: use placeholder so TTS returns minimal audio
    const segmentAudioPath = path.join(tempDir, `audio_scene_${i}.mp3`);
    const requestPayload: Record<string, unknown> = {
      voice: 'PlmstgXEUNQWiPyS27i2',
      text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.4,
        style: 0,
        use_speaker_boost: true,
        speed: 0.99
      }
    };
    if (i > 0) requestPayload.previous_text = segments[i - 1].text;
    if (i < segments.length - 1) requestPayload.next_text = segments[i + 1].text;
    const stream = await eleven.generate(requestPayload as never);
    await writeAudioFromGeneratedStream(segmentAudioPath, stream);
    segmentAudioPaths.push(segmentAudioPath);
    measuredDurations.push(await getAudioDurationSeconds(segmentAudioPath));
  };
  for (let i = 0; i < segments.length; i++) {
    try {
      await runSegment(i);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log('AUDIO', `Segment ${i} TTS failed: ${msg}`);
      try {
        await runSegment(i);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        for (const p of segmentAudioPaths) {
          try {
            if (fs.existsSync(p)) fs.unlinkSync(p);
          } catch {
            /* ignore */
          }
        }
        throw new Error(`Segment ${i} TTS failed: ${retryMsg}`);
      }
    }
  }
  await concatAudioFiles(segmentAudioPaths, path.join(tempDir, 'audio.mp3'));
  const withMeasured = withTimeline(
    segments.map((seg, idx) => ({
      clipIndex: seg.clipIndex,
      text: seg.text,
      durationSec: Math.max(0.1, measuredDurations[idx] || seg.durationSec),
      source: seg.source
    }))
  );
  return withMeasured;
}

// Trim or pad each clip to target durations so clip boundaries align with narration beats.
async function prepareClipsToTargetDurations(
  tempDir: string,
  segments: ClipSegment[]
): Promise<string[]> {
  const trimmedPaths: string[] = [];
  for (const seg of segments) {
    const targetSec = Math.max(0.1, seg.durationSec);
    const clipPath = path.join(tempDir, `clip_${seg.clipIndex}.mp4`);
    const outPath = path.join(tempDir, `trimmed_${seg.clipIndex}.mp4`);
    const dur = await getVideoDurationSeconds(clipPath);
    const speedRatio = dur > 0 ? targetSec / dur : 1;
    const adjustedSetPts = speedRatio > 1
      ? `setpts=${speedRatio}*PTS`
      : 'setpts=PTS-STARTPTS';
    const vf = `trim=duration=${dur > 0 ? Math.min(dur, targetSec) : targetSec},${adjustedSetPts},trim=duration=${targetSec},setpts=PTS-STARTPTS`;
    await new Promise<void>((resolve, reject) => {
      const chain = ffmpeg();
      chain.input(clipPath);
      chain
        .noAudio()
        .videoFilters(vf)
        .outputOptions(['-c:v libx264', '-pix_fmt yuv420p'])
        .output(outPath)
        .on('start', () => log('FFMPEG', `Clip ${seg.clipIndex}: trim/stretch to ${targetSec}s (was ${dur.toFixed(1)}s)`))
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .run();
    });
    trimmedPaths.push(outPath);
  }
  return trimmedPaths;
}

// --- Safeguards: validate before using APIs ---
function requireEnv(name: string, value: string | undefined): asserts value is string {
  if (!value || value.trim() === '') {
    log('MAIN', `Missing or empty env: ${name}. Set it in .env to use this step.`);
    process.exit(1);
  }
}

function validateApiKeysForStep(step: 'script' | 'audio' | 'video') {
  if (step === 'script') requireEnv('OPENAI_API_KEY', OPENAI_KEY);
  if (step === 'audio') requireEnv('ELEVEN_API_KEY', ELEVEN_KEY);
  if (step === 'video') requireEnv('XAI_API_KEY', XAI_API_KEY);
}

function validateTopic(topic: string): void {
  if (!topic || typeof topic !== 'string' || topic.trim() === '') {
    log('MAIN', 'Topic is empty. Set a non-empty topic.');
    process.exit(1);
  }
}

type ScriptData = {
  voiceover: string;
  scenes: Array<{
    prompt: string;
    duration?: number;
    /**
     * Narration lines that should play over this visual scene.
     * When all scene voiceovers are concatenated in order, they should roughly match the full `voiceover` above.
     */
    voiceover?: string;
  }>;
};
function validateScriptData(data: unknown): data is ScriptData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.voiceover !== 'string' || d.voiceover.trim() === '') return false;
  if (!Array.isArray(d.scenes) || d.scenes.length === 0) return false;
  return d.scenes.every((s: unknown) => s && typeof s === 'object' && typeof (s as Record<string, unknown>).prompt === 'string');
}

/** Fail early if any scene has empty or whitespace-only voiceover (needed for scene-lock and TTS). */
function validateSceneVoiceovers(scriptData: ScriptData): void {
  const bad = scriptData.scenes
    .map((s, i) => ({ i, v: String((s as { voiceover?: string }).voiceover ?? '').trim() }))
    .filter(({ v }) => !v);
  if (bad.length > 0) {
    const indices = bad.map(({ i }) => i).join(', ');
    log('MAIN', `Script invalid: every scene must have non-empty "voiceover". Missing or empty in scene(s): ${indices}.`);
    process.exit(1);
  }
}

function loadScriptFromTemp(): ScriptData {
  const scriptPath = path.join(TEMP_DIR, 'script.json');
  if (!fs.existsSync(scriptPath)) {
    log('MAIN', 'temp/script.json not found. Run step 1 first (or run without RUN_STEP).');
    process.exit(1);
  }
  const scriptText = fs.readFileSync(scriptPath, 'utf-8').trim();
  if (!scriptText) {
    log('MAIN', 'temp/script.json is empty.');
    process.exit(1);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(scriptText);
  } catch {
    log('MAIN', 'temp/script.json has invalid JSON.');
    process.exit(1);
  }
  if (!validateScriptData(raw)) {
    log('MAIN', 'temp/script.json invalid: need voiceover and scenes.');
    process.exit(1);
  }
  validateSceneVoiceovers(raw);
  return raw;
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const eleven = new ElevenLabsClient({ apiKey: ELEVEN_KEY });

const CURRENT_DEVELOPMENTS_FILE = path.join(TEMP_DIR, 'current_developments.txt');

function topicLikelyNeedsRecentDevelopments(topic: string): boolean {
  const t = topic.toLowerCase();
  const keywords = [
    'files', 'case', 'trial', 'court', 'lawsuit', 'hearing', 'investigation',
    'election', 'war', 'conflict', 'sanction', 'breaking', 'latest', 'new details',
    'exposed', 'epstein'
  ];
  return keywords.some((k) => t.includes(k));
}

async function getCurrentDevelopmentsContext(topic: string): Promise<string> {
  if (fs.existsSync(CURRENT_DEVELOPMENTS_FILE)) {
    const manual = fs.readFileSync(CURRENT_DEVELOPMENTS_FILE, 'utf-8').trim();
    if (manual) return manual;
  }
  if (!topicLikelyNeedsRecentDevelopments(topic)) return '';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: 'You extract recent, high-confidence developments for documentary scripting. If uncertain, return an empty object. No speculation.'
        },
        {
          role: 'user',
          content: [
            `Topic: "${topic}"`,
            `Today: ${today}`,
            'Return ONLY valid JSON: {"developments":["..."]}',
            'Rules:',
            '- 0 to 4 concise developments.',
            '- Prefer date/period references when known.',
            '- Exclude rumors, uncertain claims, or unverifiable details.',
            '- If no high-confidence updates, return {"developments":[]}.'
          ].join('\n')
        }
      ],
      response_format: { type: 'json_object' }
    });
    const content = completion.choices[0].message.content;
    if (!content) return '';
    const parsed = JSON.parse(content) as { developments?: string[] };
    const list = Array.isArray(parsed.developments)
      ? parsed.developments.map((d) => String(d).trim()).filter(Boolean)
      : [];
    if (!list.length) return '';
    return list.map((d) => `- ${d}`).join('\n');
  } catch {
    return '';
  }
}

/** When a scene's TTS is longer than its clip, optionally shorten voiceover via LLM and re-run TTS (one pass). */
const AUTO_SHORTEN_VOICEOVER = process.env.AUTO_SHORTEN_VOICEOVER === '1' || process.env.AUTO_SHORTEN_VOICEOVER === 'true';

async function shortenVoiceoversToFit(
  items: Array<{ sceneIndex: number; voiceover: string; maxSec: number }>
): Promise<string[]> {
  if (items.length === 0) return [];
  validateApiKeysForStep('script');
  const list = items
    .map(
      (x) =>
        `Scene ${x.sceneIndex}: max ${x.maxSec.toFixed(1)}s spoken. Current: "${x.voiceover.slice(0, 300)}${x.voiceover.length > 300 ? '…' : ''}"`
    )
    .join('\n');
  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'You shorten narration so it fits a strict time limit when spoken (~2.5 words per second). Keep the same meaning and tone. Return ONLY valid JSON: { "shortened": ["text for scene 0", "text for scene 1", ...] } in the same order as the scenes listed. No markdown.'
      },
      {
        role: 'user',
        content: `Shorten each scene voiceover so it can be spoken within the given max seconds (~${2.5} words per second). Preserve facts and tone.\n\n${list}\n\nReturn JSON: { "shortened": [ "shortened voiceover 1", "shortened voiceover 2", ... ] }`
      }
    ],
    response_format: { type: 'json_object' }
  });
  const content = completion.choices[0].message.content;
  if (!content) throw new Error('OpenAI returned empty response for voiceover shorten');
  const parsed = JSON.parse(content) as { shortened?: string[] };
  const shortened = Array.isArray(parsed.shortened) ? parsed.shortened : [];
  return items.map((_, i) => (typeof shortened[i] === 'string' && shortened[i].trim() ? shortened[i].trim() : items[i].voiceover));
}

async function generateYouTubeMetadata(topic: string, scriptData: ScriptData) {
  validateApiKeysForStep('script');
  log('YT_META', 'Generating YouTube titles, description, and tags');

  const metaPrompt = `
You are an expert YouTube Shorts strategist writing for dark, mysterious, gripping documentary-style shorts.

Video topic: "${topic}"

Full narration script:
${scriptData.voiceover}

TASK:
- Propose 20 highly clickable, curiosity-driving titles that fit the narration style (no clickbait lies).
- Write ONE YouTube description that:
  - Hooks in the first line.
  - Briefly summarizes the story in 2–3 punchy sentences.
  - Optionally adds 1–2 curiosity lines or questions at the end.
- Provide 20–30 SEO tags (as plain strings) focused on true crime / mystery / dark art / weird history, tailored to this specific story.

RETURN ONLY VALID JSON:
{
  "titles": ["title1", "title2", "... up to 20"],
  "description": "single multiline description",
  "tags": ["tag1", "tag2", "..."]
}`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-4o',
    messages: [
      {
        role: 'system',
        content:
          'You write YouTube titles, descriptions, and tags for dark, gripping, highly watchable Shorts. Always return strict JSON without markdown or comments.'
      },
      { role: 'user', content: metaPrompt }
    ],
    response_format: { type: 'json_object' }
  });

  const content = completion.choices[0].message.content;
  if (!content) {
    log('YT_META', 'OpenAI returned empty metadata response');
    return;
  }

  let parsed: { titles?: string[]; description?: string; tags?: string[] };
  try {
    parsed = JSON.parse(content);
  } catch {
    log('YT_META', 'Failed to parse metadata JSON');
    return;
  }

  const out = {
    titles: Array.isArray(parsed.titles) ? parsed.titles : [],
    description: typeof parsed.description === 'string' ? parsed.description : '',
    tags: Array.isArray(parsed.tags) ? parsed.tags : []
  };

  const metaPath = path.join(OUTPUT_DIR, 'youtube_meta.json');
  fs.writeFileSync(metaPath, JSON.stringify(out, null, 2));
  log('YT_META', `Wrote YouTube metadata to ${metaPath}`);
}

// 1. Generate Script & Prompts (JSON)
async function getScript(topic: string): Promise<ScriptData> {
  validateTopic(topic);
  validateApiKeysForStep('script');
  log('SCRIPT', `Starting script generation for topic: "${topic}"`);
  const currentDevelopments = await getCurrentDevelopmentsContext(topic);
  const developmentsInstruction = currentDevelopments
    ? `CURRENT DEVELOPMENTS (use only if they naturally fit this story):
${currentDevelopments}

INTEGRATION RULES FOR DEVELOPMENTS:
- Blend 1-2 relevant updates naturally into the narration (do not dump them as a list).
- If a development is uncertain, clearly signal uncertainty.
- Do not invent dates, names, filings, or quotes.
- Keep the script coherent: developments should support the main narrative arc, not derail it.
`
    : 'CURRENT DEVELOPMENTS: none provided. Do not invent recent updates.';
  const clipSec = TARGET_CLIP_SECONDS;
  const wordsPerScene = clipSec <= 6 ? 18 : 40; // ~3 w/s for 6s, ~4 w/s for 10s
  const prompt = TEST_MODE
    ? `Create a single ${clipSec} second test clip about: "${topic}".
       Return JSON with ONE scene only.
       - The top-level "voiceover" should contain the full ${clipSec} second narration (natural, under ${wordsPerScene} words).
       - The scene "voiceover" should be the same narration or a closely matching subset (1–3 sentences) that will be spoken while this scene is shown.
       - Scene prompt must end with "9:16 aspect ratio, vertical portrait format".
       {
         "voiceover": "Short natural narration, under ${wordsPerScene} words.",
         "scenes": [
           {
             "prompt": "Simple visual for video AI that clearly matches the narration. 9:16 aspect ratio, vertical portrait format.",
             "voiceover": "Lines spoken for this ${clipSec} second scene.",
             "duration": ${clipSec}
           }
         ]
       }`
    : `Write a YouTube Short script about: "${topic}".

       STYLE (follow this closely):
       - FACT-FIRST documentary narration. Do not write like a poem, thriller novel, or dramatic monologue.
       - Prioritize dense, specific, verifiable facts over mood or cinematic prose.
       - Use crisp, direct language. No metaphors, no flowery adjectives, no filler transitions.
       - Open with a HOOK: a specific year or moment, a name, and what they did (e.g. "In 1974, a woman named Marina Abramović walked into a gallery to do a performance that would shock the world.").
       - Pack in CONCRETE DETAIL: real names, numbers, places, dates, documents, and clear actions. Prefer unusual or surprising facts whenever true.
       - Maximize "crazy facts" density: every sentence should include at least one concrete factual element (date, count, location, named person, record, quote, filing, or physical detail).
       - Build chronologically or by clear beats. The story should ESCALATE: start with a simple hook, then reveal increasingly intense or strange details, ending on a sharp, memorable line.
       - Focus on 1–3 very specific, vivid moments or actions, not just a summary. Like in this example (DO NOT copy, only imitate the style):
         "In 1974, a woman named Marina Abramović walked into a gallery, to do a performance that would shock the world. Known as 'Rhythm 0' Abramović invited participants to do anything they desired to her for 6 hours using 72 objects, including scissors, a whip, and even a loaded gun. Everything started out calmly but soon things started to heat up as in the third hour all of her garments were cut off by a man with a sharp blade. This was just the beginning as within the next hour her throat was slit so that her blood could be sucked..."
       - Avoid flat summaries like "their bodies were found later" or "it remains a mystery". Instead, zoom into one concrete, unsettling scene or turning point and describe what actually happened.
       - No filler. Every sentence should add new factual information.
       - If a detail is uncertain or disputed, mark it briefly (e.g. "alleged", "reported", "according to court filings").

       ${developmentsInstruction}

      RULES:
       - Each clip is exactly ${clipSec} seconds. Voiceover (top-level): MAX 900 characters. Write the full narration in "voiceover" as one continuous script.
       - Scenes: 6 to 12 scenes, each "duration": ${clipSec}. One video clip will be generated per scene; each clip is exactly ${clipSec} seconds (you cannot use other lengths).
       - Each scene MUST include a "voiceover" field: the lines spoken during that scene. Each scene's voiceover must be speakable in ${clipSec} seconds (about ${wordsPerScene} words per scene max). If you concatenate all scene.voiceover strings in order, they should roughly match the full top-level "voiceover".
       - Scene prompts must be IN-DEPTH and DETAILED (2–4 sentences each): describe setting, lighting, camera angle, mood, key objects or actions, and period-appropriate details.
       - CONTINUITY: scene N should visually connect with scene N-1 using shared subject, location progression, or evolving action so clips can be stitched without context loss.
       - ART DIRECTION: include one clear camera intent (close-up / medium / wide / overhead / tracking), one motion intent (static / slow push / dolly / pan), and one aesthetic anchor (palette, texture, era-specific styling). Avoid generic AI wording like "cinematic masterpiece" without specifics.
       - DARK VISUAL LANGUAGE IS MANDATORY: every scene must feel dark in nature (low-key lighting, heavy shadows, moody contrast, unsettling atmosphere) while staying realistic and coherent with facts.
       - Make each clip feel unique and alive: distinctive composition, concrete physical details, and non-repetitive visual motifs across scenes.
       - Every prompt MUST end with: "9:16 aspect ratio, vertical portrait format". No text or captions in the visual.

       Return ONLY valid JSON:
       { "voiceover": "Full natural script, under 900 characters.", "scenes": [ { "prompt": "In-depth 2–4 sentence visual description ending with '9:16 aspect ratio, vertical portrait format'", "voiceover": "Lines spoken during this scene (max ~${wordsPerScene} words).", "duration": ${clipSec} }, ... ] }`;
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a skilled documentary and story writer. Write natural, detailed, gripping short-form scripts. Return only valid JSON. No markdown, no code fences." },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_object" }
  });
  log('SCRIPT', 'OpenAI response received, parsing JSON');
  const content = completion.choices[0].message.content;
  if (content == null) throw new Error('OpenAI returned empty script');
  const raw = JSON.parse(content);
  if (!validateScriptData(raw)) {
    log('SCRIPT', 'Invalid script: need voiceover (string) and scenes (non-empty array with .prompt).');
    throw new Error('Invalid script structure from API');
  }
  validateSceneVoiceovers(raw);
  if (raw.voiceover.length > 900) {
    log('SCRIPT', `Warning: voiceover is ${raw.voiceover.length} chars (max 900). Truncating.`);
    raw.voiceover = raw.voiceover.slice(0, 897) + '…';
  }
  log('SCRIPT', `Done. Voiceover: ${raw.voiceover.length} chars, scenes: ${raw.scenes.length} (total video ~${raw.scenes.length * TARGET_CLIP_SECONDS}s, ${TARGET_CLIP_SECONDS}s per clip)`);
  return raw;
}

function ensureVerticalPromptSuffix(prompt: string): string {
  const trimmed = (prompt || '').trim();
  const suffix = '9:16 aspect ratio, vertical portrait format';
  if (!trimmed) return suffix;
  if (trimmed.toLowerCase().includes('9:16 aspect ratio, vertical portrait format')) return trimmed;
  const normalized = trimmed.replace(/[.\s]+$/, '');
  return `${normalized}. ${suffix}`;
}

function summarizeContextLine(text: string, maxWords = 18): string {
  const words = (text || '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return '';
  if (words.length <= maxWords) return words.join(' ');
  return `${words.slice(0, maxWords).join(' ')}...`;
}

function styleAnchorFromTopic(topic: string): { motif: string; palette: string; texture: string } {
  const packs = [
    { motif: 'archival evidence board details', palette: 'dark desaturated steel-blue palette with deep blacks', texture: 'fine film grain and realistic low-key texture' },
    { motif: 'period-accurate objects in foreground', palette: 'high-contrast low-key chiaroscuro palette', texture: 'subtle documentary handheld realism with shadow-heavy depth' },
    { motif: 'symbolic environmental clues in each frame', palette: 'dark muted earth tones with selective crimson accents', texture: 'cinematic low-light texture with atmospheric haze' },
    { motif: 'forensic detail inserts between wider shots', palette: 'cold near-monochrome palette with dim warm highlights', texture: 'clean lens realism with oppressive shadows' }
  ];
  const hash = topic.split('').reduce((sum, c) => sum + c.charCodeAt(0), 0);
  return packs[Math.abs(hash) % packs.length];
}

function enrichScenePromptsForGrok(scriptData: ScriptData, topic: string): ScriptData {
  const shots = ['tight close-up', 'medium shot', 'wide environmental shot', 'over-the-shoulder perspective', 'slow overhead reveal'];
  const motions = ['static locked frame', 'slow push-in', 'gentle lateral pan', 'controlled dolly-in', 'subtle handheld drift'];
  const style = styleAnchorFromTopic(topic);
  const scenes = scriptData.scenes.map((scene, i) => {
    const prevVo = i > 0 ? summarizeContextLine(String(scriptData.scenes[i - 1].voiceover || '')) : '';
    const nextVo = i < scriptData.scenes.length - 1 ? summarizeContextLine(String(scriptData.scenes[i + 1].voiceover || '')) : '';
    const continuityLine = i === 0
      ? `Opening scene. Establish core subject in a dark, ominous setting with ${style.palette}.`
      : `Continuity from prior scene: ${prevVo || 'same subject progression'}; preserve visual thread.`;
    const forwardLine = nextVo ? `Foreshadow next beat: ${nextVo}` : 'Conclude this beat with a strong transitional visual.';
    const shotLine = `Camera: ${shots[i % shots.length]}; movement: ${motions[i % motions.length]}.`;
    const styleLine = `Art direction: ${style.motif}, ${style.palette}, ${style.texture}. Keep lighting low-key, shadow-rich, and dark in nature.`;
    const base = ensureVerticalPromptSuffix(scene.prompt);
    const merged = [
      continuityLine,
      shotLine,
      styleLine,
      base.replace(/\s*9:16 aspect ratio, vertical portrait format\.?$/i, '').trim(),
      forwardLine,
      '9:16 aspect ratio, vertical portrait format'
    ].filter(Boolean).join(' ');
    return { ...scene, prompt: merged };
  });
  return { ...scriptData, scenes };
}

// 2. Generate Video Clip with Grok (Polling Method)
async function generateGrokClip(prompt: string, index: number) {
  if (!prompt || typeof prompt !== 'string' || prompt.trim() === '') {
    log('GROK', `Clip ${index}: empty prompt — cannot call API`);
    throw new Error(`Clip ${index}: scene prompt is required`);
  }
  validateApiKeysForStep('video');
  log('GROK', `Clip ${index}: starting generation — "${prompt.substring(0, 30)}..."`);

  // A. Start Generation
  log('GROK', `Clip ${index}: submitting request to xAI API`);
  let startResponse: { data: { request_id: string } };
  try {
    startResponse = await axios.post(
      'https://api.x.ai/v1/videos/generations',
      {
        model: "grok-imagine-video", // verify current model at x.ai/docs
        prompt: prompt,
        aspect_ratio: "9:16",
        duration: 5,
        resolution: "720p"
      },
      { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } }
    );
  } catch (err: unknown) {
    const status = axios.isAxiosError(err) ? err.response?.status : null;
    const body = axios.isAxiosError(err) ? err.response?.data : null;
    if (status === 403) {
      log('GROK', '403 Forbidden from xAI. Common causes:');
      log('GROK', '  • XAI_API_KEY invalid, expired, or missing video access');
      log('GROK', '  • Video API may be limited beta — check https://x.ai or console.x.ai');
      log('GROK', `  • Response: ${JSON.stringify(body ?? err)}`);
    } else {
      log('GROK', `Request failed: ${status ?? ''} ${body ?? (err as Error).message}`);
    }
    throw err;
  }

  const requestId = startResponse.data.request_id;
  log('GROK', `Clip ${index}: request_id=${requestId}, polling for completion`);

  // B. Poll for Completion (xAI returns { video: { url }, model } when done; no "status" field)
  let videoUrl: string | null = null;
  let pollCount = 0;

  while (!videoUrl) {
    await new Promise(r => setTimeout(r, 5000)); // Wait 5s
    pollCount++;
    const statusCheck = await axios.get(
      `https://api.x.ai/v1/videos/${requestId}`,
      { headers: { 'Authorization': `Bearer ${XAI_API_KEY}` } }
    );
    const data = statusCheck.data as Record<string, unknown>;
    const status = (data.status ?? data.state ?? data.job_status) as string | undefined;
    const video = data.video as { url?: string } | undefined;
    const url = video?.url ?? (data.output_url as string) ?? (data.url as string) ?? (data.video_url as string);

    if (url) {
      videoUrl = url;
      log('GROK', `Clip ${index}: poll #${pollCount} — done, video URL received`);
      break;
    }

    log('GROK', `Clip ${index}: poll #${pollCount} — status=${status ?? 'pending'}`);

    if (status === 'failed' || status === 'error') {
      const errMsg = (data.error as { message?: string })?.message ?? (data.message as string) ?? 'unknown';
      log('GROK', `Clip ${index}: generation failed — ${errMsg}`);
      throw new Error(`Grok generation failed: ${errMsg}`);
    }
    // else pending/processing — keep polling
  }

  // C. Download
  const clipPath = `./temp/clip_${index}.mp4`;
  log('GROK', `Clip ${index}: downloading to ${clipPath}`);
  const writer = fs.createWriteStream(clipPath);
  const response = await axios({ url: videoUrl, method: 'GET', responseType: 'stream' });
  response.data.pipe(writer);
  await new Promise((resolve, reject) => {
    writer.on('finish', resolve);
    writer.on('error', reject);
  });
  log('GROK', `Clip ${index}: download finished`);
}

// 3. Main Orchestrator
const DEFAULT_TOPIC = "The Beast of Gévaudan (1760s France)";
const SELECTED_TOPIC_FILE = path.join(TEMP_DIR, 'selected_topic.txt');

async function main() {
  let topic: string;
  const envTopic = process.env.SHORT_TOPIC_OVERRIDE?.trim();
  if (envTopic) {
    topic = envTopic;
    log('MAIN', `Using topic from pipeline: "${topic}"`);
  } else if (TEST_MODE) {
    topic = "A cat sleeping on a couch";
  } else if (fs.existsSync(SELECTED_TOPIC_FILE)) {
    topic = fs.readFileSync(SELECTED_TOPIC_FILE, 'utf-8').trim();
    if (topic) log('MAIN', `Using topic from get_topic: "${topic}"`);
    else topic = DEFAULT_TOPIC;
  } else {
    topic = DEFAULT_TOPIC;
  }
  if (RUN_STEP != null && (RUN_STEP < 1 || RUN_STEP > 4)) {
    log('MAIN', 'RUN_STEP must be 1, 2, 3, or 4 (or unset to run all steps).');
    process.exit(1);
  }
  if (RUN_STEP != null) log('MAIN', `Running only STEP ${RUN_STEP}. (Unset RUN_STEP to run the full pipeline.)`);
  else log('MAIN', 'Starting full pipeline (all 4 steps).');
  if (TEST_MODE) log('MAIN', 'TEST MODE: 1 scene (~10s), per-scene audio');

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (RUN_STEP === null && !REUSE_TEMP && hasExistingProjectData()) {
    log('MAIN', '');
    log('MAIN', 'Existing project data found in temp/.');
    log('MAIN', 'We will save output/final_short.mp4 with a new name (if it exists) and clear temp/.');
    log('MAIN', '');
    const nonInteractive = process.env.AUTO_CLEAR_TEMP === '1' || process.env.NON_INTERACTIVE === '1';
    if (!nonInteractive) {
      await waitForEnter('Press Enter to save previous video and clear temp (or Ctrl+C to exit)... ');
    } else {
      log('MAIN', 'AUTO_CLEAR_TEMP/NON_INTERACTIVE set — clearing temp without prompt.');
    }
    savePreviousOutputAndClearTemp();
    log('MAIN', '');
  }

  let scriptData: ScriptData;

  // ─── STEP 1: SCRIPT ───
  if (RUN_STEP === null || RUN_STEP === 1) stepBanner(1, 'SCRIPT');
  if (RUN_STEP !== null && RUN_STEP !== 1) {
    scriptData = loadScriptFromTemp();
  } else {
    const scriptPath = path.join(TEMP_DIR, 'script.json');
    if (REUSE_TEMP && fs.existsSync(scriptPath)) {
      log('MAIN', 'Loading script from temp/script.json');
      scriptData = loadScriptFromTemp();
      log('MAIN', 'Step 1 done: script loaded');
    } else {
      log('MAIN', 'Generating script (OpenAI)');
      scriptData = await getScript(topic);
      fs.writeFileSync(scriptPath, JSON.stringify(scriptData, null, 2));
      log('MAIN', 'Step 1 done: script saved to temp/script.json');
    }
    if (RUN_STEP === 1) {
      log('MAIN', 'Step 1 complete. Run RUN_STEP=2 next, or run without RUN_STEP for full pipeline.');
      return;
    }
  }

  // ─── STEP 2: VOICEOVER ───
  scriptData = enrichScenePromptsForGrok(scriptData, topic);
  if (RUN_STEP === null || RUN_STEP === 2) stepBanner(2, 'VOICEOVER');
  const audioPath = path.join(TEMP_DIR, 'audio.mp3');
  const scenes = TEST_MODE ? scriptData.scenes.slice(0, 1) : scriptData.scenes;
  const hasPerSceneVoiceoverRaw = scenes.every(
    (s) => typeof (s as { voiceover?: string }).voiceover === 'string' && !!(s as { voiceover?: string }).voiceover?.trim()
  );
  const normalized = (t: string) => t.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  const fullVoiceNormalized = normalized(String(scriptData.voiceover || ''));
  const combinedSceneVoiceover = scenes.map((s) => String((s as { voiceover?: string }).voiceover || '')).join(' ').trim();
  const combinedSceneNormalized = normalized(combinedSceneVoiceover);
  const coverageRatio = fullVoiceNormalized.length
    ? combinedSceneNormalized.length / fullVoiceNormalized.length
    : 1;
  // Guardrail: only use per-scene audio when it appears to fully cover the full narration.
  const usePerSceneVoiceover =
    hasPerSceneVoiceoverRaw &&
    (fullVoiceNormalized.length === 0 || coverageRatio >= 0.9);

  if (RUN_STEP === null || RUN_STEP === 2) {
    if (REUSE_TEMP) {
      const allSceneAudioExist =
        usePerSceneVoiceover &&
        scenes.every((_, i) => fs.existsSync(path.join(TEMP_DIR, `audio_scene_${i}.mp3`)));
      if (allSceneAudioExist && fs.existsSync(audioPath)) {
        log('MAIN', 'Using existing per-scene temp/audio_scene_*.mp3 and combined temp/audio.mp3');
        log('MAIN', 'Step 2 done: audio ready');
      } else if (!usePerSceneVoiceover && fs.existsSync(audioPath)) {
        log('MAIN', 'Using existing temp/audio.mp3');
        log('MAIN', 'Step 2 done: audio ready');
      }
    }

    if (!REUSE_TEMP || !fs.existsSync(audioPath)) {
      validateApiKeysForStep('audio');

      if (usePerSceneVoiceover) {
        log('MAIN', 'Generating per-scene voiceover (ElevenLabs)');
        // Generate one audio file per scene: temp/audio_scene_{i}.mp3
        for (let i = 0; i < scenes.length; i++) {
          const sceneVo = (scenes[i] as { voiceover?: string }).voiceover!;
          const sceneAudioPath = path.join(TEMP_DIR, `audio_scene_${i}.mp3`);
          log('AUDIO', `Scene ${i}: generating voiceover`);
          const audioStream = await eleven.generate({
            voice: "PlmstgXEUNQWiPyS27i2",
            text: sceneVo,
            model_id: "eleven_multilingual_v2",
            voice_settings: {
              stability: 0.5,
              similarity_boost: 0.4,
              style: 0,
              use_speaker_boost: true,
              speed: 0.99
            }
          });
          const audioFile = fs.createWriteStream(sceneAudioPath);
          if (typeof (audioStream as { pipe?: unknown }).pipe === 'function') {
            await new Promise<void>((resolve, reject) => {
              (audioStream as NodeJS.ReadableStream).pipe(audioFile);
              audioFile.on('finish', () => resolve());
              audioFile.on('error', reject);
            });
          } else {
            const reader = (audioStream as unknown as ReadableStream<Uint8Array>).getReader();
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                audioFile.write(Buffer.from(value));
              }
            } finally {
              reader.releaseLock();
            }
            audioFile.end();
            await new Promise<void>((resolve, reject) => {
              audioFile.on('finish', () => resolve());
              audioFile.on('error', reject);
            });
          }
          log('AUDIO', `Scene ${i}: voiceover saved to ${sceneAudioPath}`);
        }

        // Concatenate per-scene audio files into a single temp/audio.mp3
        const listPath = path.join(TEMP_DIR, 'audio_files.txt');
        const listContent = scenes
          .map((_, i) => path.join(TEMP_DIR, `audio_scene_${i}.mp3`))
          .map((p) => `file '${p.replace(/\\/g, '/')}'`)
          .join('\n');
        fs.writeFileSync(listPath, listContent);
        log('AUDIO', `Wrote audio concat list (${scenes.length} file(s))`);

        await new Promise<void>((resolve, reject) => {
          ffmpeg()
            .input(listPath)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy'])
            .save(audioPath)
            .on('start', () => log('AUDIO', 'Concatenating per-scene audio → temp/audio.mp3'))
            .on('end', () => {
              log('AUDIO', 'Combined audio file written');
              resolve();
            })
            .on('error', (err: Error) => reject(err));
        });
        log('MAIN', 'Step 2 done: per-scene + combined audio ready');
      } else {
        log('MAIN', 'Generating single voiceover (ElevenLabs)');
        const audioStream = await eleven.generate({
          voice: "PlmstgXEUNQWiPyS27i2",
          text: scriptData.voiceover,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.4,
            style: 0,
            use_speaker_boost: true,
            speed: 0.99
          }
        });
        const audioFile = fs.createWriteStream(audioPath);
        log('AUDIO', 'Streaming to ./temp/audio.mp3');
        if (typeof (audioStream as { pipe?: unknown }).pipe === 'function') {
          await new Promise<void>((resolve, reject) => {
            (audioStream as NodeJS.ReadableStream).pipe(audioFile);
            audioFile.on('finish', () => resolve());
            audioFile.on('error', reject);
          });
        } else {
          const reader = (audioStream as unknown as ReadableStream<Uint8Array>).getReader();
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              audioFile.write(Buffer.from(value));
            }
          } finally {
            reader.releaseLock();
          }
          audioFile.end();
          await new Promise<void>((resolve, reject) => {
            audioFile.on('finish', () => resolve());
            audioFile.on('error', reject);
          });
        }
        log('AUDIO', 'Voiceover file written');
        log('MAIN', 'Step 2 done: audio saved to temp/audio.mp3');
      }
    }

    if (RUN_STEP === 2) {
      log('MAIN', 'Step 2 complete. Run RUN_STEP=3 next, or run without RUN_STEP for full pipeline.');
      return;
    }
  }

  // ─── STEP 3: VIDEO CLIPS ───
  const tempDirForClips = TEMP_DIR;
  const allClipsExist = scenes.every((_, i) => fs.existsSync(path.join(tempDirForClips, `clip_${i}.mp4`)));
  if (RUN_STEP === null || RUN_STEP === 3) {
    stepBanner(3, 'VIDEO CLIPS');
  if (MANUAL_GROK) {
    const promptsPath = path.join(tempDirForClips, 'clip_prompts.json');
    const promptsTxtPath = path.join(tempDirForClips, 'clip_prompts.txt');
    const promptsList = scenes.map((s, i) => ({ index: i, prompt: s.prompt, filename: `clip_${i}.mp4` }));
    fs.writeFileSync(promptsPath, JSON.stringify(promptsList, null, 2));
    const txtLines = promptsList.map((p) => {
      const prevCtx = p.index > 0 ? summarizeContextLine(String(scenes[p.index - 1].voiceover || scenes[p.index - 1].prompt || '')) : '';
      const nextCtx = p.index < scenes.length - 1 ? summarizeContextLine(String(scenes[p.index + 1].voiceover || scenes[p.index + 1].prompt || '')) : '';
      const lines = [
        `--- Clip ${p.index} → ${p.filename} ---`,
        prevCtx ? `Prev context: ${prevCtx}` : 'Prev context: scene opening',
        `Prompt: ${p.prompt}`,
        nextCtx ? `Next context: ${nextCtx}` : 'Next context: final scene ending'
      ];
      return lines.join('\n');
    }).join('\n\n');
    fs.writeFileSync(promptsTxtPath, txtLines);
    log('MAIN', `Step 3: manual video — exported ${scenes.length} prompts to temp/clip_prompts.json and temp/clip_prompts.txt`);
    if (!allClipsExist) {
      log('MAIN', '');
      log('VIDEO', 'Use each prompt to generate a clip, then download and save into temp/ with these exact names:');
      scenes.forEach((_, i) => log('VIDEO', `  clip_${i}.mp4`));
      log('MAIN', '');
      const nonInteractive = process.env.AUTO_CLEAR_TEMP === '1' || process.env.NON_INTERACTIVE === '1';
      if (!nonInteractive) {
        await waitForEnter('Press Enter when all clips are in temp/ to continue to assembly... ');
      } else {
        const required = scenes.map((_, i) => `clip_${i}.mp4`);
        const waitingPath = path.join(tempDirForClips, 'waiting_for_clips.json');
        fs.writeFileSync(waitingPath, JSON.stringify({ required }, null, 2));
        log('MAIN', 'NON_INTERACTIVE: wrote temp/waiting_for_clips.json — add clips then call POST /api/jobs/:id/continue');
        process.exit(0);
      }
      const nowExist = scenes.every((_, i) => fs.existsSync(path.join(tempDirForClips, `clip_${i}.mp4`)));
      if (!nowExist) {
        const missing = scenes.map((_, i) => `clip_${i}.mp4`).filter((name) => !fs.existsSync(path.join(tempDirForClips, name)));
        log('MAIN', `Missing: ${missing.join(', ')}. Put them in temp/ and run again (REUSE_TEMP=true).`);
        process.exit(1);
      }
    }
    log('MAIN', 'Step 3 done: all clips found in temp/');
  } else if (REUSE_TEMP && allClipsExist) {
    log('MAIN', `Step 3: using existing clip(s) in ./temp (skipping Grok API)`);
    log('MAIN', 'Step 3 done: all clips ready');
  } else {
    log('MAIN', `Generating ${scenes.length} clip(s) with Grok API`);
    for (let i = 0; i < scenes.length; i++) {
      await generateGrokClip(scenes[i].prompt, i);
    }
    log('MAIN', 'Step 3 done: all clips ready');
  }
  if (RUN_STEP === 3) {
    log('MAIN', 'Step 3 complete. Run RUN_STEP=4 to assemble, or run without RUN_STEP for full pipeline.');
    return;
  }
  }

  // ─── STEP 4: ASSEMBLY ───
  if (RUN_STEP === null || RUN_STEP === 4) stepBanner(4, 'ASSEMBLY');
  const tempDir = TEMP_DIR;
  const outputPath = path.join(OUTPUT_DIR, 'final_short.mp4');
  const audioFilePath = path.join(tempDir, 'audio.mp3');
  if (RUN_STEP === null || RUN_STEP === 4) {
    if (!fs.existsSync(audioFilePath)) {
      log('MAIN', 'temp/audio.mp3 not found. Run step 2 first (or RUN_STEP=2).');
      process.exit(1);
    }
    const availableClipIndices = getContiguousClipIndices(tempDir);
    if (availableClipIndices.length === 0) {
      log('MAIN', 'No clips found (expected clip_0.mp4, clip_1.mp4, ...). Run step 3 first.');
      process.exit(1);
    }
  }
  const musicPath = path.resolve(process.cwd(), BACKGROUND_MUSIC_PATH);
  const useBackgroundMusic = fs.existsSync(musicPath);
  // Force 9:16 vertical for Shorts (1080x1920); scale and crop to fill frame (no black bars)
  // Use force_original_aspect_ratio=increase so the shorter side always fits, then center-crop.
  const videoFilter9x16 = 'scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920';

  // Normalize every clip to its scene duration so visual scene changes line up with narration beats.
  // If per-scene audio files (audio_scene_i.mp3) exist, align each clip to its exact audio duration.
  const availableClipIndices = getContiguousClipIndices(tempDir);
  const allClipNames = fs.readdirSync(tempDir).filter((n) => /^clip_\d+\.mp4$/.test(n));
  const allClipIndices = allClipNames.map((n) => parseInt(n.replace(/^clip_(\d+)\.mp4$/, '$1'), 10));
  const maxContiguous = availableClipIndices.length === 0 ? -1 : Math.max(...availableClipIndices);
  if (allClipIndices.some((idx) => idx > maxContiguous)) {
    log('MAIN', 'Clips must be contiguous (clip_0.mp4, clip_1.mp4, ...). Found gaps.');
    process.exit(1);
  }
  const fullAudioSec = await getAudioDurationSeconds(audioFilePath);
  const sceneVoiceovers = scenes.map((s) => String((s as { voiceover?: string }).voiceover || '').trim());
  const hasSceneVoiceovers = sceneVoiceovers.every((v) => !!v);
  const sceneVoiceoverCoverage = computeCoverageRatio(scriptData.voiceover, sceneVoiceovers);
  // When clips >= scenes, use first N clips and run scene-lock (no extra clip in final video).
  const clipIndicesForAssembly =
    availableClipIndices.length >= scenes.length
      ? availableClipIndices.slice(0, scenes.length)
      : availableClipIndices;
  const hasAllSceneAudioForClipsUsed =
    clipIndicesForAssembly.length > 0 &&
    clipIndicesForAssembly.every((i) => fs.existsSync(path.join(tempDir, `audio_scene_${i}.mp3`)));
  const canUseSceneLockMode =
    clipIndicesForAssembly.length === scenes.length &&
    hasSceneVoiceovers &&
    (hasAllSceneAudioForClipsUsed || sceneVoiceoverCoverage >= 0.9);

  let segments: ClipSegment[];
  let mode: 'scene-driven' | 'clip-driven';
  if (canUseSceneLockMode) {
    mode = 'scene-driven';
    if (availableClipIndices.length > scenes.length) {
      log('MAIN', `Using first ${scenes.length} of ${availableClipIndices.length} clips (scene-lock; extra clips ignored).`);
    }
    const base: Array<{ clipIndex: number; text: string; durationSec: number; source: 'scene-driven'; sourceClipDurationSec?: number }> = [];
    for (const clipIndex of clipIndicesForAssembly) {
      const clipDur = await getVideoDurationSeconds(path.join(tempDir, `clip_${clipIndex}.mp4`));
      base.push({
        clipIndex,
        text: sceneVoiceovers[clipIndex] || String(scenes[clipIndex].prompt || '').trim(),
        durationSec: Math.max(0.1, scenes[clipIndex].duration || SCENE_DURATION_DEFAULT),
        source: 'scene-driven' as const,
        sourceClipDurationSec: clipDur > 0 ? clipDur : undefined
      });
    }
    segments = await regenerateSegmentAudio(tempDir, withTimeline(base));
    segments = segments.map((seg, idx) => ({ ...seg, sourceClipDurationSec: base[idx].sourceClipDurationSec }));

    // Optional: if any segment is much longer than its clip, shorten voiceover via LLM and re-run TTS once.
    const stretchThreshold = 1.5;
    const overflowIndices = segments
      .map((seg, idx) => {
        const clipSec = base[idx].sourceClipDurationSec ?? TARGET_CLIP_SECONDS;
        const ratio = clipSec > 0 ? seg.durationSec / clipSec : 0;
        return ratio > stretchThreshold ? idx : -1;
      })
      .filter((i) => i >= 0);
    if (AUTO_SHORTEN_VOICEOVER && overflowIndices.length > 0) {
      const toShorten = overflowIndices.map((idx) => ({
        sceneIndex: idx,
        voiceover: base[idx].text,
        maxSec: Math.min((base[idx].sourceClipDurationSec ?? TARGET_CLIP_SECONDS) * 1.2, TARGET_CLIP_SECONDS)
      }));
      log('AUDIO', `Shortening voiceover for ${toShorten.length} scene(s) that exceed clip length (AUTO_SHORTEN_VOICEOVER).`);
      const shortened = await shortenVoiceoversToFit(toShorten);
      for (let i = 0; i < overflowIndices.length; i++) {
        const idx = overflowIndices[i];
        const newText = shortened[i] ?? base[idx].text;
        scriptData.scenes[idx] = { ...scriptData.scenes[idx], voiceover: newText } as (typeof scriptData.scenes)[0];
        base[idx] = { ...base[idx], text: newText };
      }
      segments = await regenerateSegmentAudio(tempDir, withTimeline(base));
      segments = segments.map((seg, idx) => ({ ...seg, sourceClipDurationSec: base[idx].sourceClipDurationSec }));
    }

    log('FFMPEG', `Preparing clips in scene-lock mode with regenerated scene audio (${segments.length} clip(s))`);
  } else {
    mode = 'clip-driven';
    const clipCount = availableClipIndices.length;
    const narrativeSegments = splitVoiceoverByClipCount(scriptData.voiceover, clipCount);
    const weights = narrativeSegments.map((t) => Math.max(1, t.trim().split(/\s+/).filter(Boolean).length));
    const fallbackDurations = distributeDurationsByWeight(
      fullAudioSec > 0 ? fullAudioSec : clipCount * SCENE_DURATION_DEFAULT,
      weights
    );
    segments = withTimeline(
      availableClipIndices.map((clipIndex, idx) => ({
        clipIndex,
        text: narrativeSegments[idx] ?? '',
        durationSec: fallbackDurations[idx] ?? SCENE_DURATION_DEFAULT,
        source: 'clip-driven' as const
      }))
    );
    // Context-first: regenerate segment audio with neighboring segment context.
    segments = await regenerateSegmentAudio(tempDir, segments);
    const clipDurations = await Promise.all(
      availableClipIndices.map((clipIndex) => getVideoDurationSeconds(path.join(tempDir, `clip_${clipIndex}.mp4`)))
    );
    segments = segments.map((seg) => {
      const idx = availableClipIndices.indexOf(seg.clipIndex);
      return {
        ...seg,
        sourceClipDurationSec: idx >= 0 && clipDurations[idx] > 0 ? clipDurations[idx] : undefined
      };
    });
    log('FFMPEG', `Preparing clips in clip-driven mode (${segments.length} clip(s))`);
  }

  const mergedAudioSec = await getAudioDurationSeconds(audioFilePath);
  const alignment = buildAlignmentChecks(
    mode,
    scriptData.voiceover,
    segments,
    mergedAudioSec,
    clipIndicesForAssembly.length,
    scenes.length
  );
  writeSegmentMap(OUTPUT_DIR, {
    mode,
    clipCount: segments.length,
    audioDurationSec: Number((mergedAudioSec || fullAudioSec || 0).toFixed(3)),
    segments
  });
  ensureAlignmentOrBlock(alignment, OUTPUT_DIR, scenes.length);
  log('FFMPEG', 'Preparing clips: trim/pad each scene to its target duration for better audio sync');
  const trimmedPaths = await prepareClipsToTargetDurations(tempDir, segments);

  await new Promise<void>((resolve, reject) => {
    const chain = ffmpeg();

    if (segments.length === 1) {
      log('FFMPEG', `Single clip: muxing + audio${useBackgroundMusic ? ' + background music (fade in/out)' : ''} → ${outputPath} (9:16)`);
      chain.input(trimmedPaths[0]);
    } else {
      const listPath = path.join(tempDir, 'files.txt');
      const fileList = trimmedPaths
        .map((p) => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(listPath, fileList);
      log('FFMPEG', `Wrote concat list (${segments.length} file(s))`);
      chain.input(listPath).inputOptions(['-f concat', '-safe 0']);
    }

    chain.input(audioFilePath);
    if (useBackgroundMusic) chain.input(musicPath);

    if (!useBackgroundMusic) {
      chain
        .outputOptions([
          '-vf', videoFilter9x16,
          '-c:v libx264',
          '-pix_fmt yuv420p',
          '-shortest',
          '-map 0:v:0',
          '-map 1:a'
        ])
        .save(outputPath)
        .on('start', () => log('FFMPEG', 'FFmpeg process started'))
        .on('end', () => {
          log('FFMPEG', 'Encode finished');
          log('MAIN', `Pipeline complete. Output: ${outputPath}`);
          resolve();
        })
        .on('error', (err: Error) => {
          log('FFMPEG', `Error: ${err.message}`);
          reject(err);
        });
      return;
    }

    // With background music: video 9:16 + mix voice + music (fade in/out)
    getAudioDurationSeconds(audioFilePath)
      .then((voiceDur) => {
        const fadeOutStart = Math.max(0, voiceDur - 2);
        const filter = [
          `[0:v:0]${videoFilter9x16}[v]`,
          '[1:a]volume=1[vo]',
          `[2:a]volume=0.18,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=2[bg]`,
          '[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]'
        ].join(';');
        chain
          .outputOptions([
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-shortest',
            '-filter_complex', filter,
            '-map [v]',
            '-map [aout]'
          ])
          .save(outputPath)
          .on('start', () => log('FFMPEG', 'FFmpeg process started (voice + music, fade in/out)'))
          .on('end', () => {
            log('FFMPEG', 'Encode finished');
            log('MAIN', `Pipeline complete. Output: ${outputPath}`);
            resolve();
          })
          .on('error', (err: Error) => {
            log('FFMPEG', `Error: ${err.message}`);
            reject(err);
          });
      })
      .catch(reject);
  });

  // ─── STEP 5: YOUTUBE METADATA (TITLES / DESCRIPTION / TAGS) ───
  try {
    await generateYouTubeMetadata(topic, scriptData);
  } catch (err) {
    log('YT_META', `Metadata generation failed: ${(err as Error).message}`);
  }
}

main().catch((err) => {
  log('MAIN', `Fatal error: ${err.message}`);
  process.exit(1);
});