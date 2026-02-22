import 'dotenv/config';
import axios from 'axios';
import OpenAI from 'openai'; // or GoogleGenerativeAI for Gemini
import { execSync } from 'child_process';
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const readline = require('readline') as typeof import('readline');
import { ElevenLabsClient } from 'elevenlabs';
const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

const FFMPEG_PATH = process.env.FFMPEG_PATH?.trim() || undefined;
if (FFMPEG_PATH) {
  ffmpeg.setFfmpegPath(FFMPEG_PATH);
}

function getFfmpegCommand(): string {
  return FFMPEG_PATH ?? 'ffmpeg';
}

function normalizeEnvValue(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^['"]|['"]$/g, '');
}

// CONFIG (overridable via .env)
const TEST_MODE = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1';
const REUSE_TEMP = process.env.REUSE_TEMP === 'true' || process.env.REUSE_TEMP === '1';
const MANUAL_GROK = process.env.MANUAL_GROK !== 'false' && process.env.MANUAL_GROK !== '0'; // true = no xAI API; you create clips in Grok terminal and put them in temp/
const BACKGROUND_MUSIC_PATH = process.env.BACKGROUND_MUSIC_PATH || 'temp/background_music.mp3'; // optional; fade in/out applied
const BACKGROUND_MUSIC_START_SEC = Math.max(0, parseFloat(String(process.env.BACKGROUND_MUSIC_START_SEC || '0')) || 0);
const RUN_STEP = process.env.RUN_STEP ? parseInt(process.env.RUN_STEP, 10) : null; // 1=script only, 2=voiceover only, 3=clips/prompts only, 4=assembly only; unset = all 4
const XAI_API_KEY = normalizeEnvValue(process.env.XAI_API_KEY);
const OPENAI_KEY = normalizeEnvValue(process.env.OPENAI_API_KEY);
const ELEVEN_KEYS = Array.from(
  new Set(
    [normalizeEnvValue(process.env.ELEVEN_API_KEY), normalizeEnvValue(process.env.ELEVENLABS_API_KEY)]
      .filter((v): v is string => !!v)
  )
);
const ELEVEN_KEY = ELEVEN_KEYS[0];

// Video format: short (~1 min), 5min, or 11min. Drives total length, scene count, aspect ratio, resolution.
type VideoFormatId = 'short' | '5min' | '11min';

const VIDEO_FORMAT_RAW = (process.env.VIDEO_FORMAT ?? 'short').toLowerCase();
const VIDEO_FORMAT: VideoFormatId =
  VIDEO_FORMAT_RAW === '5min' || VIDEO_FORMAT_RAW === '11min' ? VIDEO_FORMAT_RAW : 'short';

interface VideoFormatConfig {
  totalDurationSec: number;
  sceneCountMin: number;
  sceneCountMax: number;
  voiceoverMinChars?: number;
  voiceoverMaxChars: number;
  aspectRatio: '9:16' | '16:9';
  width: number;
  height: number;
  promptAspectSuffix: string;
}

function getVideoFormatConfig(): VideoFormatConfig {
  const clipSec = 10;
  switch (VIDEO_FORMAT) {
    case '5min':
      return {
        totalDurationSec: 300,
        sceneCountMin: 28,
        sceneCountMax: 32,
        voiceoverMinChars: 4500,  // 5 min: 4500–5000 chars
        voiceoverMaxChars: 5000,
        aspectRatio: '16:9',
        width: 1920,
        height: 1080,
        promptAspectSuffix: '16:9 aspect ratio, landscape format'
      };
    case '11min':
      return {
        totalDurationSec: 660,
        sceneCountMin: 62,
        sceneCountMax: 70,
        voiceoverMaxChars: 9900,
        aspectRatio: '16:9',
        width: 1920,
        height: 1080,
        promptAspectSuffix: '16:9 aspect ratio, landscape format'
      };
    default:
      return {
        totalDurationSec: 45,   // shorts: 35–45 sec
        sceneCountMin: 4,
        sceneCountMax: 6,
        voiceoverMinChars: 550,  // shorts: at least 550, below 925
        voiceoverMaxChars: 924,
        aspectRatio: '9:16',
        width: 1080,
        height: 1920,
        promptAspectSuffix: '9:16 aspect ratio, vertical portrait format'
      };
  }
}

const VIDEO_FORMAT_CONFIG = getVideoFormatConfig();

// Opening zoom at start of final video (assembly step 4): duration in seconds and end zoom factor (1.0 = no zoom).
const OPENING_ZOOM_DURATION_SEC = 3;
const OPENING_ZOOM_END_FACTOR = 1.05; // zoom from ~1.05 at t=0 to 1.0 at t=OPENING_ZOOM_DURATION_SEC

// End blackout: add this many seconds of black at end of video with music fading out (assembly step 4).
const END_BLACKOUT_DURATION_SEC = 2;
const END_BLACKOUT_FPS = 25;
const END_BLACKOUT_DISABLED = process.env.DISABLE_END_BLACKOUT === '1';

// Clip length in seconds (used for all formats). Drives scene duration and voiceover length per scene.
const TARGET_CLIP_SECONDS = (() => {
  const raw = process.env.TARGET_CLIP_SECONDS ?? '10';
  const n = parseInt(raw, 10);
  if (n === 6 || n === 10) return n;
  return 10;
})();
const SCENE_DURATION_DEFAULT = TARGET_CLIP_SECONDS;

function log(step: string, message: string) {
  console.log(`[${step}] ${message}`);
}

let drawtextSupportCache: boolean | null = null;
function supportsDrawtextFilter(): boolean {
  if (drawtextSupportCache != null) return drawtextSupportCache;
  try {
    const out = execSync(`${getFfmpegCommand()} -hide_banner -filters`, { encoding: 'utf-8' });
    drawtextSupportCache = /\bdrawtext\b/.test(out);
  } catch {
    drawtextSupportCache = false;
  }
  return drawtextSupportCache;
}

let subtitlesFilterNameCache: 'subtitles' | 'ass' | null | false = null;
/** Returns 'subtitles' (preferred) or 'ass' if FFmpeg can burn ASS; null if probed, false if unavailable. */
function getSubtitlesFilterName(): 'subtitles' | 'ass' | null {
  if (subtitlesFilterNameCache !== null && subtitlesFilterNameCache !== false) return subtitlesFilterNameCache;
  if (subtitlesFilterNameCache === false) return null;
  try {
    const out = execSync(`${getFfmpegCommand()} -hide_banner -filters`, { encoding: 'utf-8' });
    if (/\bsubtitles\b/.test(out)) {
      subtitlesFilterNameCache = 'subtitles';
      return 'subtitles';
    }
    if (/\bass\b/.test(out)) {
      subtitlesFilterNameCache = 'ass';
      return 'ass';
    }
  } catch {
    // ignore
  }
  subtitlesFilterNameCache = false;
  return null;
}
function supportsAssFilter(): boolean {
  return getSubtitlesFilterName() != null;
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

/** Subtitle chunk: one on-screen cue with start/end and text (used for ASS, SRT, drawtext). */
export type SubChunk = { startSec: number; endSec: number; text: string };

const MAX_WORDS_PER_CHUNK = 4;
const MIN_CHUNK_DURATION_SEC = 0.5;
const MAX_SUBTITLE_CHUNKS = 100;

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

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp'];

function getImagePathForIndex(tempDir: string, index: number): string | null {
  for (const ext of IMAGE_EXTENSIONS) {
    const p = path.join(tempDir, `image_${index}${ext}`);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function segmentHasClipOrImage(tempDir: string, index: number): boolean {
  if (fs.existsSync(path.join(tempDir, `clip_${index}.mp4`))) return true;
  return getImagePathForIndex(tempDir, index) !== null;
}

function getContiguousClipIndices(tempDir: string): number[] {
  const indices: number[] = [];
  let i = 0;
  while (segmentHasClipOrImage(tempDir, i)) {
    indices.push(i);
    i += 1;
  }
  return indices;
}

/** Create a 9:16 video from a static image with a slow zoom-in effect. */
async function createVideoFromImageWithZoom(
  imagePath: string,
  outPath: string,
  durationSec: number
): Promise<void> {
  const fps = 25;
  const totalFrames = Math.max(1, Math.round(fps * durationSec));
  const zoomEnd = 1.25;
  const zoomIncrement = (zoomEnd - 1) / totalFrames;
  const w = VIDEO_FORMAT_CONFIG.width;
  const h = VIDEO_FORMAT_CONFIG.height;
  const zoompan = `zoompan=z='min(zoom+${zoomIncrement.toFixed(6)},${zoomEnd})':d=${totalFrames}:s=${w}x${h}:fps=${fps}`;
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input(imagePath)
      .inputOptions(['-loop', '1'])
      .videoFilters(zoompan)
      .outputOptions(['-t', String(durationSec), '-c:v', 'libx264', '-pix_fmt', 'yuv420p'])
      .output(outPath)
      .on('start', () => log('FFMPEG', `Image → video with zoom: ${path.basename(imagePath)} → ${durationSec.toFixed(1)}s`))
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .run();
  });
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

/** Split segments into small subtitle chunks (by punctuation and/or max words); distribute time proportionally. */
function segmentToSubChunks(
  segments: ClipSegment[],
  opts?: { maxWordsPerChunk?: number; minChunkDurationSec?: number; maxChunks?: number }
): SubChunk[] {
  const maxWords = opts?.maxWordsPerChunk ?? MAX_WORDS_PER_CHUNK;
  const minDur = opts?.minChunkDurationSec ?? MIN_CHUNK_DURATION_SEC;
  const maxChunks = opts?.maxChunks ?? MAX_SUBTITLE_CHUNKS;
  const out: SubChunk[] = [];

  for (const seg of segments) {
    const raw = (seg.text || '').trim();
    if (!raw) continue;
    if (out.length >= maxChunks) break;

    const segStart = seg.startSec;
    const segEnd = seg.endSec;
    const segDur = Math.max(0.01, segEnd - segStart);

    const phrases = raw.split(/(?<=[.,!?])\s+|\n+/).map((p) => p.trim()).filter(Boolean);
    const wordsAll: string[] = [];
    for (const p of phrases) {
      const w = p.split(/\s+/).filter(Boolean);
      wordsAll.push(...w);
    }
    if (wordsAll.length === 0) continue;

    const chunks: string[] = [];
    let acc: string[] = [];
    for (const w of wordsAll) {
      acc.push(w);
      if (acc.length >= maxWords) {
        chunks.push(acc.join(' '));
        acc = [];
      }
    }
    if (acc.length > 0) chunks.push(acc.join(' '));

    const totalLen = chunks.reduce((s, c) => s + c.length, 0) || 1;
    let t = segStart;
    for (let i = 0; i < chunks.length && out.length < maxChunks; i++) {
      const isLast = i === chunks.length - 1;
      const start = t;
      const end = isLast ? segEnd : Math.min(segEnd, t + Math.max(minDur, (segDur * chunks[i].length) / totalLen));
      t = end;
      if (end > start) {
        out.push({ startSec: start, endSec: end, text: chunks[i] });
      }
    }
  }
  return out;
}

/** Seconds to ASS time format H:MM:SS.cc */
function secToAssTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.round((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.min(99, cs)).padStart(2, '0')}`;
}

/** Seconds to SRT time format H:MM:SS,mmm */
function secToSrtTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Normalize dashes/hyphens for subtitle display: hyphen (-), en dash (–), em dash (—) become space so e.g. "collapsing—dizziness" → "collapsing dizziness". */
function stripHyphensForSubtitles(text: string): string {
  return (text || '')
    .replace(/[-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Build SRT file content from subtitle chunks (for soft subtitle track when burn-in unavailable). */
function buildSrtFromChunks(chunks: SubChunk[]): string {
  const lines: string[] = [];
  let index = 0;
  for (const ch of chunks) {
    const text = stripHyphensForSubtitles(ch.text || '').toUpperCase().replace(/\r\n/g, '\n').replace(/\n/g, '\n');
    if (!text) continue;
    index += 1;
    lines.push(String(index));
    lines.push(`${secToSrtTime(ch.startSec)} --> ${secToSrtTime(ch.endSec)}`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

/** Escape text for ASS Dialogue line (backslash, braces, newlines). */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r\n/g, '\\N')
    .replace(/\n/g, '\\N')
    .replace(/\r/g, '\\N')
    .trim();
}

/** Format one chunk as ASS Dialogue text: bold, italic, uppercase; two lines — first line red, second line yellow (split by word count). Use 8-digit &H00BBGGRR& for libass. */
function formatAssChunkText(text: string): string {
  const words = stripHyphensForSubtitles(text || '').split(/\s+/).filter(Boolean);
  if (!words.length) return '';
  const mid = Math.ceil(words.length / 2);
  const firstLine = words.slice(0, mid).join(' ').toUpperCase();
  const secondLine = words.slice(mid).join(' ').toUpperCase();
  const esc1 = escapeAssText(firstLine);
  if (!secondLine.trim()) return `{\\1c&H000000FF&\\b1}${esc1}`;
  const esc2 = escapeAssText(secondLine);
  return `{\\1c&H000000FF&\\b1}${esc1}\\N{\\1c&H0000FFFF&\\b1}${esc2}`;
}

// Subtitle layout: max 25% of screen height; font 20% smaller than 128 → 102. Position: between center and bottom (larger bottom margin).
const SUBTITLE_FONT_SIZE = 102;
const SUBTITLE_MARGIN_V = 300;
const SUBTITLE_OUTLINE = 4;

/** Build full ASS file content from subtitle chunks. Style: bold, two lines red/yellow, thick outline, bottom-center; sized to stay within 25% of screen. */
function buildAssFromChunks(chunks: SubChunk[]): string {
  const lines: string[] = [
    '[Script Info]',
    'ScriptType: v4.00+',
    'PlayResX: 1080',
    'PlayResY: 1920',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Default,Arial,${SUBTITLE_FONT_SIZE},&H0000FFFF&,&H0000FFFF&,&H00000000&,&H80000000&,-1,-1,0,0,100,100,0,0,1,${SUBTITLE_OUTLINE},2,2,60,60,${SUBTITLE_MARGIN_V},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const marginL = 60;
  const marginR = 60;
  const marginV = SUBTITLE_MARGIN_V;
  for (const ch of chunks) {
    const text = formatAssChunkText(ch.text);
    if (!text) continue;
    const start = secToAssTime(ch.startSec);
    const end = secToAssTime(ch.endSec);
    lines.push(`Dialogue: 0,${start},${end},Default,,${marginL},${marginR},${marginV},,${text}`);
  }
  return lines.join('\n') + '\n';
}

/** Escape a file path for use inside FFmpeg subtitles/ass filter (forward slashes; escape single quotes and colons for filter parser). */
function escapeSubtitlesPathForFfmpeg(filePath: string): string {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return normalized.replace(/'/g, "\\'").replace(/:/g, '\\:');
}

/** Build drawtext filter chain from subtitle chunks (fallback when ass/subtitles filter is unavailable). Two lines per chunk: first red, second yellow; sized to stay within 25% of screen. */
function buildDrawtextSubtitlesFilterFromChunks(chunks: SubChunk[]): string {
  const parts: string[] = [];
  const maxChunks = 80;
  const fontSize = SUBTITLE_FONT_SIZE;
  const lineHeight = Math.round(fontSize * 1.35);
  const secondLineY = `h-${SUBTITLE_MARGIN_V}`;
  const firstLineY = `h-${SUBTITLE_MARGIN_V + lineHeight}`;
  for (let i = 0; i < Math.min(chunks.length, maxChunks); i++) {
    const ch = chunks[i];
    const words = stripHyphensForSubtitles(ch.text || '').split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const mid = Math.ceil(words.length / 2);
    const firstLine = words.slice(0, mid).join(' ').toUpperCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const secondLine = words.slice(mid).join(' ').toUpperCase().replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const en = `between(t\\,${ch.startSec}\\,${ch.endSec})`;
    if (firstLine) parts.push(`drawtext=text='${firstLine}':enable='${en}':fontsize=${fontSize}:x=(w-text_w)/2:y=${firstLineY}:fontcolor=red:borderw=3:bordercolor=black`);
    if (secondLine) parts.push(`drawtext=text='${secondLine}':enable='${en}':fontsize=${fontSize}:x=(w-text_w)/2:y=${secondLineY}:fontcolor=yellow:borderw=3:bordercolor=black`);
  }
  return parts.length ? ',' + parts.join(',') : '';
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
  // Scene-lock uses regenerated per-scene audio and can have small concat/codec drift.
  // Clip-driven: strict for shorts; relax for 5min/11min where many clips and slower TTS can cause uneven segment lengths.
  const isLongFormat = VIDEO_FORMAT === '5min' || VIDEO_FORMAT === '11min';
  const durationDeltaLimit =
    mode === 'scene-driven' ? 1.25 : mode === 'clip-driven' && isLongFormat ? 1.25 : 0.35;
  if (checks.durationDeltaSec > durationDeltaLimit) reasons.push('duration_delta_too_high');
  if (checks.emptySegmentCount > 0) reasons.push('empty_segment_text');
  const stretchRatioLimit = mode === 'clip-driven' && isLongFormat ? 4.5 : 1.8;
  if (mode === 'clip-driven' && checks.maxStretchRatio > stretchRatioLimit) {
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
      voice_settings: getElevenVoiceSettings()
    };
    if (i > 0) requestPayload.previous_text = segments[i - 1].text;
    if (i < segments.length - 1) requestPayload.next_text = segments[i + 1].text;
    const stream = await generateElevenAudio(requestPayload);
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
// sourcePathOverrides: optional map of clipIndex -> path to use instead of clip_N.mp4 (e.g. from_image_N.mp4).
async function prepareClipsToTargetDurations(
  tempDir: string,
  segments: ClipSegment[],
  sourcePathOverrides?: Map<number, string>
): Promise<string[]> {
  const trimmedPaths: string[] = [];
  for (const seg of segments) {
    const targetSec = Math.max(0.1, seg.durationSec);
    const clipPath = sourcePathOverrides?.get(seg.clipIndex) ?? path.join(tempDir, `clip_${seg.clipIndex}.mp4`);
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

const SCRIPT_PROVIDER = process.env.SCRIPT_PROVIDER === 'grok' ? 'grok' : 'openai';

function validateApiKeysForStep(step: 'script' | 'audio' | 'video') {
  if (step === 'script') {
    if (SCRIPT_PROVIDER === 'grok') requireEnv('XAI_API_KEY', XAI_API_KEY);
    else requireEnv('OPENAI_API_KEY', OPENAI_KEY);
  }
  if (step === 'audio') requireEnv('ELEVEN_API_KEY or ELEVENLABS_API_KEY', ELEVEN_KEY);
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

const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;
const grokScriptClient = XAI_API_KEY ? new OpenAI({ apiKey: XAI_API_KEY, baseURL: 'https://api.x.ai/v1' }) : null;
const GROK_SCRIPT_MODEL = 'grok-3-latest';
/** Client and model for script (and developments context): Grok when SCRIPT_PROVIDER=grok, else OpenAI. */
const scriptClient = SCRIPT_PROVIDER === 'grok' ? grokScriptClient : openai;
const scriptModel = SCRIPT_PROVIDER === 'grok' ? GROK_SCRIPT_MODEL : 'gpt-4o';
const elevenClients = ELEVEN_KEYS.map((apiKey) => new ElevenLabsClient({ apiKey }));

function isElevenUnauthorized(err: unknown): boolean {
  const e = err as {
    statusCode?: number;
    status?: number;
    response?: { status?: number };
    message?: string;
  };
  const status = e.statusCode ?? e.status ?? e.response?.status;
  if (status === 401) return true;
  const msg = String(e.message ?? '');
  return /(^|\s)401(\s|$)|unauthorized|invalid api key/i.test(msg);
}

async function generateElevenAudio(requestPayload: Record<string, unknown>): Promise<unknown> {
  if (elevenClients.length === 0) {
    throw new Error('Missing ElevenLabs API key (set ELEVEN_API_KEY or ELEVENLABS_API_KEY).');
  }
  let lastErr: unknown;
  for (let i = 0; i < elevenClients.length; i++) {
    try {
      return await elevenClients[i].generate(requestPayload as never);
    } catch (err) {
      lastErr = err;
      const canRetry = i < elevenClients.length - 1;
      if (canRetry && isElevenUnauthorized(err)) {
        log('AUDIO', 'ElevenLabs 401 with current key; retrying with alternate key.');
        continue;
      }
      throw err;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? 'ElevenLabs generate failed'));
}

/** Slightly slower, more laid-back voice for 5min (and 11min); default for shorts. */
function getElevenVoiceSettings(): { stability: number; similarity_boost: number; style: number; use_speaker_boost: boolean; speed: number } {
  const isLongFormat = VIDEO_FORMAT === '5min' || VIDEO_FORMAT === '11min';
  return {
    stability: isLongFormat ? 0.58 : 0.5,
    similarity_boost: 0.4,
    style: 0,
    use_speaker_boost: true,
    speed: isLongFormat ? 0.92 : 0.99  // slightly slower for 5/11 min
  };
}

const CURRENT_DEVELOPMENTS_FILE = path.join(TEMP_DIR, 'current_developments.txt');
const CURRENT_DEVELOPMENTS_RAW_FILE = path.join(TEMP_DIR, 'current_developments_raw.txt');
const COMPETITOR_INTEL_RAW_FILE = path.join(TEMP_DIR, 'competitor_intel_raw.txt');

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
  if (fs.existsSync(CURRENT_DEVELOPMENTS_RAW_FILE)) {
    const raw = fs.readFileSync(CURRENT_DEVELOPMENTS_RAW_FILE, 'utf-8').trim();
    if (raw && scriptClient) {
      try {
        const completion = await scriptClient.chat.completions.create({
          model: scriptModel,
          messages: [
            {
              role: 'system',
              content: 'You structure user-provided context into developments for documentary scripting. Return only valid JSON. Do not add information not present in the text.'
            },
            {
              role: 'user',
              content: `The user provided the following context. Extract 0 to 4 concise, factual developments for documentary scripting. Return ONLY valid JSON: {"developments":["..."]}. Do not add information not present in the text.\n\n${raw}`
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
        if (list.length) return list.map((d) => `- ${d}`).join('\n');
      } catch {
        /* fall through to fallback */
      }
    }
  }
  if (!topicLikelyNeedsRecentDevelopments(topic)) return '';
  if (!scriptClient) return '';
  try {
    const today = new Date().toISOString().slice(0, 10);
    const completion = await scriptClient.chat.completions.create({
      model: scriptModel,
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

function getCompetitorIntelContext(): string {
  if (!fs.existsSync(COMPETITOR_INTEL_RAW_FILE)) return '';
  try {
    const raw = fs.readFileSync(COMPETITOR_INTEL_RAW_FILE, 'utf-8').trim();
    if (!raw) return '';
    const parsed = JSON.parse(raw) as {
      topTopics?: string[];
      titlePatterns?: string[];
      postingPatterns?: string[];
      opportunities?: string[];
      shortSuggestions?: string[];
      longVideoSuggestions?: string[];
    };
    const lines: string[] = [];
    const addList = (label: string, arr: unknown, max = 5) => {
      if (!Array.isArray(arr) || arr.length === 0) return;
      lines.push(`${label}:`);
      arr.slice(0, max).forEach((x) => lines.push(`- ${String(x).trim()}`));
    };
    addList('Top topics in competitor uploads', parsed.topTopics);
    addList('Recurring title patterns', parsed.titlePatterns);
    addList('Posting patterns', parsed.postingPatterns, 4);
    addList('Opportunity gaps', parsed.opportunities, 4);
    addList('Short-form ideas', parsed.shortSuggestions, 4);
    addList('Long-form ideas', parsed.longVideoSuggestions, 4);
    return lines.join('\n').trim();
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
  if (!scriptClient) throw new Error('Script client not available for voiceover shorten');
  const completion = await scriptClient.chat.completions.create({
    model: scriptModel,
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
Topic: "${topic}"

Script (direct, fact-based):
${scriptData.voiceover}

TASK:
- 20 titles: direct, fact-based, curiosity-driven. Match the script's tone—no hype, no fake claims. One clear fact or hook per title.
- One description: first line states what the story is. Next 2–3 sentences give concrete details (names, dates, what happened). Optional one-line hook at the end. Plain language.
- 20–30 tags: specific to this story (names, events, themes). No generic filler.

Return ONLY valid JSON:
{ "titles": ["...", ...], "description": "...", "tags": ["...", ...] }`;

  if (!scriptClient) throw new Error('Script client not available for metadata');
  const completion = await scriptClient.chat.completions.create({
    model: scriptModel,
    messages: [
      {
        role: 'system',
        content:
          'You write YouTube titles, descriptions, and tags. Direct and fact-based; no clickbait. Return strict JSON only; no markdown or comments.'
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
async function getScript(topic: string, options?: { retryTooShort?: boolean }): Promise<ScriptData> {
  validateTopic(topic);
  validateApiKeysForStep('script');
  const retryTooShort = options?.retryTooShort === true;
  log('SCRIPT', retryTooShort ? `Retrying script (previous was too short) for topic: "${topic}"` : `Starting script generation for topic: "${topic}"`);
  const currentDevelopments = await getCurrentDevelopmentsContext(topic);
  const competitorIntelContext = getCompetitorIntelContext();
  const developmentsInstruction = currentDevelopments
    ? `CURRENT DEVELOPMENTS (user-provided or recent context — USE THESE FOR REAL FACTS):
${currentDevelopments}

RULES FOR USING DEVELOPMENTS:
- These are your primary source for standout facts. Pull specific names, numbers, dates, and filings from them and weave them into the script — do not stay vague or generic when the context gives you concrete details.
- Use at least 2–3 of the strongest facts from the list; lead with or highlight the most surprising or newsworthy one. The script should feel fact-rich and current because of this context.
- Do not dump them as a list; weave each fact into the narrative at the right beat. If something is uncertain, signal it briefly.
- Do not invent dates, names, or quotes that are not in the developments. Keep the script coherent so developments support the main arc.
`
    : 'CURRENT DEVELOPMENTS: none provided. Do not invent recent updates. Rely on established, verifiable facts for the topic.';
  const competitorInstruction = competitorIntelContext
    ? `COMPETITOR INTEL (signal only; do not copy):
${competitorIntelContext}

RULES FOR USING COMPETITOR INTEL:
- Use these as market signals for angle, pacing, and hook strength.
- Never copy titles, wording, sequence, or unique framing from competitors.
- Keep this script original and tailored to the current topic.
`
    : 'COMPETITOR INTEL: none provided.';
  const cfg = VIDEO_FORMAT_CONFIG;
  const clipSec = TARGET_CLIP_SECONDS;
  const wordsPerScene = clipSec <= 6 ? 18 : 40; // ~3 w/s for 6s, ~4 w/s for 10s
  const shortsLengthRule =
    cfg.voiceoverMinChars != null
      ? `\nLENGTH (non-negotiable for this short): The total "voiceover" text MUST be between ${cfg.voiceoverMinChars} and ${cfg.voiceoverMaxChars} characters. Never output fewer than ${cfg.voiceoverMinChars} or more than ${cfg.voiceoverMaxChars}. Count characters.\n`
      : '';
  const retryBanner = retryTooShort && cfg.voiceoverMinChars != null
    ? `\nCRITICAL: The previous script was rejected because the voiceover was too short. You MUST write a longer script. Total voiceover MUST be between ${cfg.voiceoverMinChars} and ${cfg.voiceoverMaxChars} characters. No exceptions.\n`
    : '';
  const prompt = TEST_MODE
    ? `Create a single ${clipSec} second test clip about: "${topic}".
       Return JSON with ONE scene only.
       - The top-level "voiceover" should contain the full ${clipSec} second narration (natural, under ${wordsPerScene} words).
       - The scene "voiceover" should be the same narration or a closely matching subset (1–3 sentences) that will be spoken while this scene is shown.
       - Scene prompt must end with "${cfg.promptAspectSuffix}".
       {
         "voiceover": "Short natural narration, under ${wordsPerScene} words.",
         "scenes": [
           {
             "prompt": "Simple visual for video AI that clearly matches the narration. If a person is shown, state their gender (e.g. a woman, a man). ${cfg.promptAspectSuffix}.",
             "voiceover": "Lines spoken for this ${clipSec} second scene.",
             "duration": ${clipSec}
           }
         ]
       }`
    : `${retryBanner}TOPIC: "${topic}"
${shortsLengthRule}
VOICE — Direct, fact-based, natural:
- The first line is critical: make it catchy so the viewer doesn't scroll away. Then write like one person telling another what actually happened. No documentary-narrator fluff. No "folks," "embarking," "delve," "enchanting," or stagey phrases.
- Lead with facts: real names, dates, numbers, places. Weave in concrete details (who, when, where, what was said or done). If you have developments below, use 2–3 of the strongest facts.
- Sound natural when read aloud: vary sentence length and rhythm. Mix short punchy lines with longer flowing ones. Avoid a list-like or bullet-point tone. Use simple words; if something is alleged or disputed, say "reported" or "alleged." Do not invent quotes, dates, or names that aren't in the topic or developments.

HOOK (First 1–3 Seconds) — This is where viewers decide to stay or scroll. The first line or two when read aloud must:
- Create immediate emotional tension: the opener should feel at least one of shocking, mysterious, uncomfortable, or curiosity-inducing so people stop scrolling.
- Use a curiosity gap: the brain resists incomplete information—create a question or tension that is only resolved later in the script so the viewer stays to find out.
- Example opener styles (use as inspiration, not copy): "This experiment went horribly wrong…" / "People didn't know what would happen next…" Vary the opener; avoid the same pattern every time.

STRUCTURE (${cfg.sceneCountMin}–${cfg.sceneCountMax} scenes):
- Opening (required): Follow the HOOK rules above. First 1–3 seconds must grab attention; then move into the story. Vary the opener.
- Middle: what actually happened, in order. One sharp detail or twist per scene.
- End with one sharp line or takeaway. One short CTA only if needed (subscribe or watch next, not both). No long sign-off.

HARD LIMITS:
- Total voiceover ${cfg.voiceoverMinChars != null ? `at least ${cfg.voiceoverMinChars} and under ${cfg.voiceoverMaxChars + 1} characters` : `max ${cfg.voiceoverMaxChars} characters`}. Each clip is ${clipSec} seconds; each scene voiceover speakable in ${clipSec} seconds (~${wordsPerScene} words per scene max).

SCENE PROMPTS (for video AI) — each "prompt" must:
- TIME: Exact era/year when the story happens (e.g. 2004 France, 1920s Japan). No generic "modern" when the story is set in a specific time.
- LOCATION: Specific place (Tokyo street, Paris precinct, Manhattan, etc.). Not generic "police" or "authorities."
- PEOPLE: If the scene shows a person or people, always state their gender in the prompt (e.g. "a woman", "a man", "a boy", "a girl", "two men") so the video AI can generate correct visuals. Do not use "person" or "people" without specifying gender when describing characters on screen.
- STYLE: Dark, noir, period-accurate. Low-key lighting, shadows, cinematic. Include setting, camera angle, one motion, key objects. Scene N connects to N-1. Every prompt MUST end with: "${cfg.promptAspectSuffix}".

       ${developmentsInstruction}

       ${competitorInstruction}

OUTPUT: Strict JSON only. No markdown.
- "voiceover": full narration (${cfg.voiceoverMinChars != null ? `min ${cfg.voiceoverMinChars}, max ${cfg.voiceoverMaxChars}` : `max ${cfg.voiceoverMaxChars}`} chars).
- "scenes": array of ${cfg.sceneCountMin}–${cfg.sceneCountMax} items. Each: "prompt" (2–4 sentences; if a person is shown, state their gender e.g. woman, man, boy, girl; end with "${cfg.promptAspectSuffix}"), "voiceover" (lines for this scene, ~${wordsPerScene} words), "duration": ${clipSec}. Scene voiceovers concatenated = full voiceover.

{ "voiceover": "...", "scenes": [ { "prompt": "...", "voiceover": "...", "duration": ${clipSec} }, ... ] }`;
  const systemContent =
    cfg.voiceoverMinChars != null
      ? 'You write documentary scripts. Voice: direct, fact-based, natural—like telling a friend what happened. Vary sentence length; avoid list-like or choppy rhythm. No narrator fluff. CRITICAL: The total voiceover MUST be between ' +
        cfg.voiceoverMinChars +
        ' and ' +
        cfg.voiceoverMaxChars +
        ' characters. Never under ' +
        cfg.voiceoverMinChars +
        ' or over ' +
        cfg.voiceoverMaxChars +
        '. Return only valid JSON; no markdown or commentary.'
      : 'You write documentary scripts. Voice: direct, fact-based, natural—like telling a friend what happened. Vary sentence length; avoid list-like or choppy rhythm. No narrator fluff. Return only valid JSON; no markdown or commentary.';

  if (!scriptClient) {
    throw new Error(SCRIPT_PROVIDER === 'grok' ? 'XAI_API_KEY required for Grok script' : 'OPENAI_API_KEY required for script');
  }
  const completion = await scriptClient.chat.completions.create({
    model: scriptModel,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: prompt }
    ],
    response_format: { type: "json_object" }
  });
  log('SCRIPT', `${SCRIPT_PROVIDER === 'grok' ? 'Grok' : 'OpenAI'} response received, parsing JSON`);
  const content = completion.choices[0].message.content;
  if (content == null) throw new Error('OpenAI returned empty script');
  const raw = JSON.parse(content);
  if (!validateScriptData(raw)) {
    log('SCRIPT', 'Invalid script: need voiceover (string) and scenes (non-empty array with .prompt).');
    throw new Error('Invalid script structure from API');
  }
  validateSceneVoiceovers(raw);
  const maxChars = VIDEO_FORMAT_CONFIG.voiceoverMaxChars;
  const minChars = VIDEO_FORMAT_CONFIG.voiceoverMinChars;
  if (raw.voiceover.length > maxChars) {
    log('SCRIPT', `Warning: voiceover is ${raw.voiceover.length} chars (max ${maxChars}). Truncating.`);
    raw.voiceover = raw.voiceover.slice(0, maxChars - 3) + '…';
  }
  if (minChars != null && raw.voiceover.length < minChars && !retryTooShort) {
    log('SCRIPT', `Voiceover too short: ${raw.voiceover.length} chars (min ${minChars}). Retrying once.`);
    return getScript(topic, { retryTooShort: true });
  }
  log('SCRIPT', `Done. Voiceover: ${raw.voiceover.length} chars, scenes: ${raw.scenes.length} (total video ~${raw.scenes.length * TARGET_CLIP_SECONDS}s, ${TARGET_CLIP_SECONDS}s per clip)`);
  return raw;
}

function ensureAspectPromptSuffix(prompt: string): string {
  const trimmed = (prompt || '').trim();
  const suffix = VIDEO_FORMAT_CONFIG.promptAspectSuffix;
  if (!trimmed) return suffix;
  const lower = trimmed.toLowerCase();
  if (lower.includes('9:16 aspect ratio') || lower.includes('16:9 aspect ratio')) return trimmed;
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
    { motif: 'noir archival evidence board details', palette: 'dark desaturated steel-blue with deep blacks', texture: 'film grain, low-key noir texture' },
    { motif: 'period-accurate objects in foreground, stylized noir', palette: 'high-contrast chiaroscuro, deep shadows', texture: 'shadow-heavy depth, cinematic noir' },
    { motif: 'symbolic environmental clues, dark stylized', palette: 'dark muted earth tones with selective crimson', texture: 'atmospheric haze, noir low-light' },
    { motif: 'forensic detail inserts, noir aesthetic', palette: 'cold near-monochrome with dim warm highlights', texture: 'oppressive shadows, stylized cinematic' }
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
    const styleLine = `Art direction: ${style.motif}, ${style.palette}, ${style.texture}. Dark noir stylized look: low-key lighting, deep shadows, high contrast, cinematic and atmospheric.`;
    const base = ensureAspectPromptSuffix(scene.prompt);
    const aspectSuffix = VIDEO_FORMAT_CONFIG.promptAspectSuffix;
    const baseWithoutAspect = base
      .replace(/\s*9:16 aspect ratio[^.]*\.?$/i, '')
      .replace(/\s*16:9 aspect ratio[^.]*\.?$/i, '')
      .trim();
    const merged = [
      continuityLine,
      shotLine,
      styleLine,
      baseWithoutAspect,
      forwardLine,
      aspectSuffix
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
        aspect_ratio: VIDEO_FORMAT_CONFIG.aspectRatio === '16:9' ? "16:9" : "9:16",
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
const USED_TOPICS_FILE = path.join(TEMP_DIR, 'used_topics.txt');
const MAX_USED_TOPICS = 200;

function appendUsedTopicToFile(topic: string): void {
  const t = (topic || '').trim();
  if (!t) return;
  const norm = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
  let used: string[] = [];
  if (fs.existsSync(USED_TOPICS_FILE)) {
    const raw = fs.readFileSync(USED_TOPICS_FILE, 'utf-8').trim();
    used = raw ? raw.split('\n').map((l) => l.trim()).filter(Boolean) : [];
  }
  if (used.some((u) => norm(u) === norm(t))) return;
  used.push(t);
  const toWrite = used.slice(-MAX_USED_TOPICS).join('\n') + (used.length > MAX_USED_TOPICS ? '\n' : '');
  fs.writeFileSync(USED_TOPICS_FILE, toWrite, 'utf-8');
}

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
  appendUsedTopicToFile(topic);
  if (RUN_STEP != null && (RUN_STEP < 1 || RUN_STEP > 4)) {
    log('MAIN', 'RUN_STEP must be 1, 2, 3, or 4 (or unset to run all steps).');
    process.exit(1);
  }
  if (RUN_STEP != null) log('MAIN', `Running only STEP ${RUN_STEP}. (Unset RUN_STEP to run the full pipeline.)`);
  else log('MAIN', 'Starting full pipeline (all 4 steps).');
  log('MAIN', `Video format: ${VIDEO_FORMAT} (${VIDEO_FORMAT_CONFIG.totalDurationSec}s target, ${VIDEO_FORMAT_CONFIG.sceneCountMin}-${VIDEO_FORMAT_CONFIG.sceneCountMax} scenes, ${VIDEO_FORMAT_CONFIG.width}x${VIDEO_FORMAT_CONFIG.height} ${VIDEO_FORMAT_CONFIG.aspectRatio})`);
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
          const audioStream = await generateElevenAudio({
            voice: "PlmstgXEUNQWiPyS27i2",
            text: sceneVo,
            model_id: "eleven_multilingual_v2",
            voice_settings: getElevenVoiceSettings()
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
        const audioStream = await generateElevenAudio({
          voice: "PlmstgXEUNQWiPyS27i2",
          text: scriptData.voiceover,
          model_id: "eleven_multilingual_v2",
          voice_settings: getElevenVoiceSettings()
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
  const allClipsExist = scenes.every((_, i) => segmentHasClipOrImage(tempDirForClips, i));
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
      const nowExist = scenes.every((_, i) => segmentHasClipOrImage(tempDirForClips, i));
      if (!nowExist) {
        const missing = scenes.map((_, i) => `clip_${i}.mp4 or image_${i}.jpg/png`).filter((_, i) => !segmentHasClipOrImage(tempDirForClips, i));
        log('MAIN', `Missing (per scene): ${missing.join('; ')}. Put clips or images in temp/ and run again (REUSE_TEMP=true).`);
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
  if (useBackgroundMusic && BACKGROUND_MUSIC_START_SEC > 0) {
    log('FFMPEG', `Background music will start at ${BACKGROUND_MUSIC_START_SEC}s into the track.`);
  }
  // Scale and crop to format resolution (9:16 or 16:9); no black bars
  const vw = VIDEO_FORMAT_CONFIG.width;
  const vh = VIDEO_FORMAT_CONFIG.height;
  const videoFilterScale = `scale=${vw}:${vh}:force_original_aspect_ratio=increase,crop=${vw}:${vh}`;
  const disclaimerText = 'People shown are not real. For dramatization only.';
  const disclaimerDrawtext = `drawtext=text='${disclaimerText.replace(/'/g, "\\'")}':fontsize=20:x=(w-text_w)/2:y=14:fontcolor=white:borderw=1:bordercolor=black@0.6`;
  const canUseDrawtext = supportsDrawtextFilter();
  const videoFilterWithDisclaimer = canUseDrawtext ? `${videoFilterScale},${disclaimerDrawtext}` : videoFilterScale;
  if (!canUseDrawtext) {
    log('FFMPEG', 'drawtext filter unavailable; rendering without disclaimer text.');
  }

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
      const sceneDur = Math.max(0.1, scenes[clipIndex].duration || SCENE_DURATION_DEFAULT);
      const imagePath = getImagePathForIndex(tempDir, clipIndex);
      const clipPath = path.join(tempDir, `clip_${clipIndex}.mp4`);
      const clipDur = imagePath ? 0 : (fs.existsSync(clipPath) ? await getVideoDurationSeconds(clipPath) : 0);
      base.push({
        clipIndex,
        text: sceneVoiceovers[clipIndex] || String(scenes[clipIndex].prompt || '').trim(),
        durationSec: sceneDur,
        source: 'scene-driven' as const,
        sourceClipDurationSec: imagePath ? sceneDur : (clipDur > 0 ? clipDur : undefined)
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
      availableClipIndices.map(async (clipIndex) => {
        if (getImagePathForIndex(tempDir, clipIndex)) return 0;
        return getVideoDurationSeconds(path.join(tempDir, `clip_${clipIndex}.mp4`));
      })
    );
    segments = segments.map((seg) => {
      const idx = availableClipIndices.indexOf(seg.clipIndex);
      const raw = idx >= 0 && clipDurations[idx] > 0 ? clipDurations[idx] : 0;
      return {
        ...seg,
        sourceClipDurationSec: raw > 0 ? raw : (getImagePathForIndex(tempDir, seg.clipIndex) ? seg.durationSec : undefined)
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
  const sourcePathOverrides = new Map<number, string>();
  for (const seg of segments) {
    const imagePath = getImagePathForIndex(tempDir, seg.clipIndex);
    if (imagePath) {
      const fromImagePath = path.join(tempDir, `from_image_${seg.clipIndex}.mp4`);
      await createVideoFromImageWithZoom(imagePath, fromImagePath, Math.max(0.1, seg.durationSec));
      sourcePathOverrides.set(seg.clipIndex, fromImagePath);
    }
  }
  log('FFMPEG', 'Preparing clips: trim/pad each scene to its target duration for better audio sync');
  const trimmedPaths = await prepareClipsToTargetDurations(tempDir, segments, sourcePathOverrides.size > 0 ? sourcePathOverrides : undefined);

  // Subtitles: chunk segments into small cues, then build ASS (red/yellow bold) and SRT. Use absolute path so FFmpeg finds the file.
  const subtitlesPath = path.resolve(tempDir, 'subtitles.ass');
  const srtPath = path.resolve(tempDir, 'subtitles.srt');
  let subtitlesFilter = '';
  let softSubtitlesPath: string | null = null;
  const segmentsWithText = segments.filter((s) => (s.text || '').trim());
  if (segmentsWithText.length > 0) {
    try {
      const chunks = segmentToSubChunks(segments);
      const assContent = buildAssFromChunks(chunks);
      fs.writeFileSync(subtitlesPath, assContent, 'utf-8');
      const srtContent = buildSrtFromChunks(chunks);
      fs.writeFileSync(srtPath, srtContent, 'utf-8');
      const escapedPath = escapeSubtitlesPathForFfmpeg(subtitlesPath);
      const subFilter = getSubtitlesFilterName();
      if (subFilter) {
        subtitlesFilter = `,${subFilter}='${escapedPath}'`;
        log('FFMPEG', `Wrote subtitles.ass (${chunks.length} cues) for burned-in captions (${subFilter} filter).`);
      } else if (canUseDrawtext) {
        subtitlesFilter = buildDrawtextSubtitlesFilterFromChunks(chunks);
        if (subtitlesFilter) {
          log('FFMPEG', `Burning in captions via drawtext (${chunks.length} cues; no ass/subtitles filter).`);
        } else {
          softSubtitlesPath = srtPath;
          log('FFMPEG', `Wrote subtitles.srt (${chunks.length} cues) as soft subtitle track; no burn-in available.`);
          log('FFMPEG', 'To burn subtitles: install FFmpeg with libass (e.g. brew install skyzyx/homebrew-ffmpeg/ffmpeg) and set FFMPEG_PATH to that binary if needed.');
        }
      } else {
        softSubtitlesPath = srtPath;
        log('FFMPEG', `Wrote subtitles.srt (${chunks.length} cues) as soft subtitle track; FFmpeg has no ass/subtitles or drawtext.`);
        log('FFMPEG', 'To burn subtitles: install FFmpeg with libass (e.g. brew install skyzyx/homebrew-ffmpeg/ffmpeg) and set FFMPEG_PATH to that binary if needed.');
      }
    } catch (e) {
      log('FFMPEG', `Could not write subtitles: ${(e as Error).message}; continuing without.`);
    }
  } else {
    log('FFMPEG', 'No segment text for subtitles; skipping burned-in captions.');
  }

  // Opening zoom: first OPENING_ZOOM_DURATION_SEC seconds zoom from OPENING_ZOOM_END_FACTOR to 1.0 (scale then time-based crop).
  // Use floor() so crop gets integers; use n (frame number) not t so expression is valid at config time (some builds fail on t in crop).
  const zEnd = OPENING_ZOOM_END_FACTOR;
  const zDur = OPENING_ZOOM_DURATION_SEC;
  const zCoeff = (zEnd - 1).toFixed(2);
  const zoomFrames = OPENING_ZOOM_DURATION_SEC * 25; // assume 25fps for expr
  const zoomDenom = `(${zEnd}-${zCoeff}*min(1\\,n/${zoomFrames}))`;
  const zoomFilter = `scale=${vw * zEnd}:${vh * zEnd},crop=floor(iw/${zoomDenom}):floor(ih/${zoomDenom}):floor((iw-iw/${zoomDenom})/2):floor((ih-ih/${zoomDenom})/2),scale=${vw}:${vh}`;

  // Full video chain: scale+crop → opening zoom → disclaimer → subtitles (ass/subtitles or drawtext fallback)
  const videoFilterNoSubs =
    videoFilterScale +
    ',' +
    zoomFilter +
    (canUseDrawtext ? ',' + disclaimerDrawtext : '');
  const videoFilterFull = videoFilterNoSubs + (subtitlesFilter || '');
  if (subtitlesFilter) {
    log('FFMPEG', 'Burning in subtitles.');
  }
  const voiceDurPromise = getAudioDurationSeconds(audioFilePath);

  await new Promise<void>((resolve, reject) => {
    const chain = ffmpeg();

    if (segments.length === 1) {
      log('FFMPEG', `Single clip: muxing + audio${useBackgroundMusic ? ' + background music (fade in/out)' : ''}${END_BLACKOUT_DISABLED ? '' : ` + ${END_BLACKOUT_DURATION_SEC}s blackout`} → ${outputPath} (9:16)`);
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
    if (useBackgroundMusic) {
      const musicInputOpts = BACKGROUND_MUSIC_START_SEC > 0
        ? ['-ss', String(BACKGROUND_MUSIC_START_SEC), '-stream_loop', '-1']
        : ['-stream_loop', '-1'];
      chain.input(musicPath).inputOptions(musicInputOpts);
    }
    if (softSubtitlesPath) {
      chain.input(softSubtitlesPath);
    }

    voiceDurPromise
      .then((voiceDur) => {
        // #region agent log
        const pathPayload = { location: 'automate_shorts.ts:single_clip_assembly_path', message: 'Single-clip assembly path', data: { END_BLACKOUT_DISABLED, voiceDur, useBackgroundMusic }, timestamp: Date.now() };
        fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(pathPayload) }).catch(() => {});
        try { const logPath = process.env.CURSOR_DEBUG_LOG_PATH || path.join(__dirname, '.cursor', 'debug.log'); fs.appendFileSync(logPath, JSON.stringify(pathPayload) + '\n'); } catch (_) {}
        // #endregion
        if (END_BLACKOUT_DISABLED) {
          log('FFMPEG', 'End blackout disabled (DISABLE_END_BLACKOUT=1); using simple mux (scale+crop only, no zoom/subtitles/disclaimer).');
          const simpleFilter = `[0:v:0]${videoFilterScale}[v]`;
          const audioFilters = useBackgroundMusic
            ? [
                '[1:a]volume=1[vo]',
                `[2:a]atrim=0:${voiceDur.toFixed(3)},asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=2,afade=t=out:st=${Math.max(0, voiceDur - 2).toFixed(2)}:d=2[bg]`,
                '[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]'
              ]
            : ['[1:a]volume=1[aout]'];
          const filter = [simpleFilter, ...audioFilters].join(';');
          const simpleStderr: string[] = [];
          const srtMap = softSubtitlesPath ? ([ '-map', useBackgroundMusic ? '3:s' : '2:s', '-c:s', 'mov_text', '-disposition:s:0', 'default' ] as const) : [];
          chain
            .outputOptions([
              '-c:v libx264',
              '-pix_fmt yuv420p',
              '-shortest',
              '-filter_complex', filter,
              '-map [v]',
              '-map [aout]',
              ...srtMap
            ])
            .save(outputPath)
            .on('stderr', (line: string) => { simpleStderr.push(line); log('FFMPEG', line); })
            .on('end', () => {
              // #region agent log
              const endPayload = { location: 'automate_shorts.ts:simple_path_ffmpeg_end', message: 'Simple path FFmpeg finished', data: { runId: 'simple', outputPath }, timestamp: Date.now() };
              fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(endPayload) }).catch(() => {});
              try { const logPath = process.env.CURSOR_DEBUG_LOG_PATH || path.join(__dirname, '.cursor', 'debug.log'); fs.appendFileSync(logPath, JSON.stringify(endPayload) + '\n'); } catch (_) {}
              // #endregion
              log('FFMPEG', 'Encode finished');
              log('MAIN', `Pipeline complete. Output: ${outputPath}`);
              resolve();
            })
            .on('error', (err: Error) => {
              // #region agent log
              const errPayload = { location: 'automate_shorts.ts:simple_path_ffmpeg_error', message: 'Simple path FFmpeg error', data: { runId: 'simple', errMessage: err.message, END_BLACKOUT_DISABLED: true, filterUsed: filter.slice(0, 1000), stderrLines: simpleStderr.slice(-40) }, timestamp: Date.now() };
              fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(errPayload) }).catch(() => {});
              try { const logPath = process.env.CURSOR_DEBUG_LOG_PATH || path.join(__dirname, '.cursor', 'debug.log'); fs.appendFileSync(logPath, JSON.stringify(errPayload) + '\n'); } catch (_) {}
              // #endregion
              log('FFMPEG', `Error: ${err.message}`);
              reject(err);
            });
          return;
        }

        const totalDur = voiceDur + END_BLACKOUT_DURATION_SEC;
        const voiceDurStr = voiceDur.toFixed(3);
        const totalDurStr = totalDur.toFixed(3);

        const videoPart = `[0:v:0]${videoFilterFull},trim=duration=${voiceDurStr},setpts=PTS-STARTPTS,fps=${END_BLACKOUT_FPS},format=yuv420p[v]`;
        const blackPart = `color=c=black:s=${vw}x${vh}:d=${END_BLACKOUT_DURATION_SEC}:r=${END_BLACKOUT_FPS},format=yuv420p[black]`;
        const concatPart = `[v][black]concat=n=2:v=1:a=0[vout]`;

        const voicePadBase = `[1:a]atrim=0:${voiceDurStr},aresample=44100,aformat=channel_layouts=stereo[vo_trim];anullsrc=r=44100:cl=stereo:d=${END_BLACKOUT_DURATION_SEC}[pad];[vo_trim][pad]concat=n=2:v=0:a=1`;
        let filterParts: string[];
        if (!useBackgroundMusic) {
          filterParts = [videoPart, blackPart, concatPart, `${voicePadBase}[aout]`];
        } else {
          const fadeOutStart = voiceDur;
          filterParts = [
            videoPart,
            blackPart,
            concatPart,
            `${voicePadBase}[vo]`,
            `[2:a]atrim=0:${totalDurStr},asetpts=PTS-STARTPTS,volume=0.18,afade=t=in:st=0:d=2,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${END_BLACKOUT_DURATION_SEC}[bg]`,
            '[vo][bg]amix=inputs=2:duration=first:dropout_transition=0[aout]'
          ];
        }

        const filter = filterParts.join(';');
        const filterScriptPath = path.join(tempDir, 'ffmpeg_filter.txt');
        fs.writeFileSync(filterScriptPath, filter, 'utf-8');

        // #region agent log
        const absFilterPath = path.resolve(filterScriptPath);
        fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            location: 'automate_shorts.ts:filter_before_ffmpeg',
            message: 'Filter script written; values for FFmpeg',
            data: {
              hypothesisId: 'A_B_D',
              filterLen: filter.length,
              filterHead: filter.slice(0, 500),
              filterTail: filter.slice(-300),
              voiceDurStr,
              totalDurStr,
              filterScriptPath: absFilterPath,
              scriptExists: fs.existsSync(filterScriptPath),
              scriptSize: fs.existsSync(filterScriptPath) ? fs.statSync(filterScriptPath).size : 0,
              useBackgroundMusic
            },
            timestamp: Date.now()
          })
        }).catch(() => {});
        // #endregion

        const stderrLines: string[] = [];
        const srtMapFull = softSubtitlesPath ? ([ '-map', useBackgroundMusic ? '3:s' : '2:s', '-c:s', 'mov_text', '-disposition:s:0', 'default' ] as const) : [];
        chain
          .outputOptions([
            '-c:v libx264',
            '-pix_fmt yuv420p',
            '-filter_complex_script', filterScriptPath,
            '-map [vout]',
            '-map [aout]',
            ...srtMapFull
          ])
          .save(outputPath)
          .on('stderr', (line: string) => {
            stderrLines.push(line);
            log('FFMPEG', line);
          })
          .on('start', (commandLine: string) => {
            // #region agent log
            fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'automate_shorts.ts:ffmpeg_start',
                message: 'FFmpeg command line received',
                data: { hypothesisId: 'E', commandLine: typeof commandLine === 'string' ? commandLine : String(commandLine) },
                timestamp: Date.now()
              })
            }).catch(() => {});
            // #endregion
            log(
              'FFMPEG',
              useBackgroundMusic
                ? `FFmpeg started (voice + music fade + ${END_BLACKOUT_DURATION_SEC}s blackout)`
                : `FFmpeg started (voice + ${END_BLACKOUT_DURATION_SEC}s blackout)`
            );
          })
          .on('end', () => {
            log('FFMPEG', 'Encode finished');
            log('MAIN', `Pipeline complete. Output: ${outputPath}`);
            resolve();
          })
          .on('error', (err: Error) => {
            // #region agent log
            const stderrCombined = stderrLines.length > 0 ? stderrLines.join('\n') : '';
            fetch('http://127.0.0.1:7243/ingest/5e7b5b2b-23bc-4e56-a664-d2d1fb861811', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                location: 'automate_shorts.ts:ffmpeg_error',
                message: 'FFmpeg error with stderr',
                data: {
                  hypothesisId: 'stderr',
                  errMessage: err.message,
                  stderrLines: stderrCombined
                },
                timestamp: Date.now()
              })
            }).catch(() => {});
            // #endregion
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