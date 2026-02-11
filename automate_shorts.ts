import 'dotenv/config';
import axios from 'axios';
import OpenAI from 'openai'; // or GoogleGenerativeAI for Gemini
const fs = require('fs') as typeof import('fs');
const path = require('path') as typeof import('path');
const readline = require('readline') as typeof import('readline');
import { ElevenLabsClient } from 'elevenlabs';
const ffmpeg = require('fluent-ffmpeg') as typeof import('fluent-ffmpeg');

// CONFIG
const TEST_MODE = false; // false = full 30s short with multiple scenes
const REUSE_TEMP = false; // set true to skip API calls when script/audio/clips already exist
const MANUAL_GROK = true; // true = no xAI API; you create clips in Grok terminal and put them in temp/
const BACKGROUND_MUSIC_PATH = process.env.BACKGROUND_MUSIC_PATH || 'temp/background_music.mp3'; // optional; fade in/out applied
const RUN_STEP = process.env.RUN_STEP ? parseInt(process.env.RUN_STEP, 10) : null; // 1=script only, 2=voiceover only, 3=clips/prompts only, 4=assembly only; unset = all 4
const XAI_API_KEY = process.env.XAI_API_KEY;
const ELEVEN_KEY = process.env.ELEVEN_API_KEY;
const OPENAI_KEY = process.env.OPENAI_API_KEY;

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

const TEMP_DIR = path.resolve(process.cwd(), 'temp');
const OUTPUT_DIR = path.resolve(process.cwd(), 'output');

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

type ScriptData = { voiceover: string; scenes: Array<{ prompt: string; duration?: number }> };
function validateScriptData(data: unknown): data is ScriptData {
  if (!data || typeof data !== 'object') return false;
  const d = data as Record<string, unknown>;
  if (typeof d.voiceover !== 'string' || d.voiceover.trim() === '') return false;
  if (!Array.isArray(d.scenes) || d.scenes.length === 0) return false;
  return d.scenes.every((s: unknown) => s && typeof s === 'object' && typeof (s as Record<string, unknown>).prompt === 'string');
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
  return raw;
}

const openai = new OpenAI({ apiKey: OPENAI_KEY });
const eleven = new ElevenLabsClient({ apiKey: ELEVEN_KEY });

// 1. Generate Script & Prompts (JSON)
async function getScript(topic: string): Promise<ScriptData> {
  validateTopic(topic);
  validateApiKeysForStep('script');
  log('SCRIPT', `Starting script generation for topic: "${topic}"`);
  const prompt = TEST_MODE
    ? `Create a tiny 5–10 second test clip about: "${topic}". 
       Return JSON with ONE scene only. Scene prompt must end with "9:16 aspect ratio, vertical portrait format".
       { "voiceover": "One short sentence, under 10 words.", "scenes": [ { "prompt": "Simple visual for video AI, one scene. 9:16 aspect ratio, vertical portrait format.", "duration": 5 } ] }`
    : `Write a YouTube Short script about: "${topic}".

       STYLE (follow this closely):
       - Natural, conversational narration—like a documentary or a gripping story. No stiff or vague phrasing.
       - Open with a HOOK: a specific year or moment, a name, and what they did (e.g. "In 1974, a woman named Marina Abramović walked into a gallery to do a performance that would shock the world.").
       - Pack in CONCRETE DETAIL: real names, numbers, places, objects, and clear actions. List specific items (e.g. "72 objects, including scissors, a whip, and even a loaded gun"). Describe what actually happened in order—not "things got intense" but "in the third hour her garments were cut off by a man with a sharp blade."
       - Build chronologically or by clear beats. End with a short punchy line that sticks (e.g. "still remains a controversial and thought-provoking piece").
       - No filler. Every sentence should add a fact, an image, or tension.

       RULES:
       - Voiceover: MAX 900 characters including spaces. Write the full narration in "voiceover".
       - Scenes: 6 to 12 scenes, each "duration": 5. One video clip will be generated per scene.
       - Scene prompts must be IN-DEPTH and DETAILED (2–4 sentences each): describe setting, lighting, camera angle, mood, key objects or actions, and period-appropriate details. Every prompt MUST end with: "9:16 aspect ratio, vertical portrait format" so the video is correct for Shorts. Example: "Dim 1970s white gallery space, single woman in neutral clothes standing motionless beside a long table. On the table lie 72 objects including scissors, a whip, roses, and a loaded gun. Harsh overhead lights, tense stillness, spectators visible in soft focus at the edges. Documentary style, cinematic. 9:16 aspect ratio, vertical portrait format." No text or captions in the visual.

       Return ONLY valid JSON:
       { "voiceover": "Full natural script, under 900 characters.", "scenes": [ { "prompt": "In-depth 2–4 sentence visual description ending with '9:16 aspect ratio, vertical portrait format'", "duration": 5 }, ... ] }`;
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
  if (raw.voiceover.length > 900) {
    log('SCRIPT', `Warning: voiceover is ${raw.voiceover.length} chars (max 900). Truncating.`);
    raw.voiceover = raw.voiceover.slice(0, 897) + '…';
  }
  log('SCRIPT', `Done. Voiceover: ${raw.voiceover.length} chars, scenes: ${raw.scenes.length} (total video ~${raw.scenes.length * 5}s)`);
  return raw;
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
  if (TEST_MODE) {
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
  if (TEST_MODE) log('MAIN', 'TEST MODE: 1 scene, short voiceover');

  if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

  if (RUN_STEP === null && !REUSE_TEMP && hasExistingProjectData()) {
    log('MAIN', '');
    log('MAIN', 'Existing project data found in temp/.');
    log('MAIN', 'We will save output/final_short.mp4 with a new name (if it exists) and clear temp/.');
    log('MAIN', '');
    await waitForEnter('Press Enter to save previous video and clear temp (or Ctrl+C to exit)... ');
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
  if (RUN_STEP === null || RUN_STEP === 2) stepBanner(2, 'VOICEOVER');
  const audioPath = path.join(TEMP_DIR, 'audio.mp3');
  if (RUN_STEP === null || RUN_STEP === 2) {
    if (REUSE_TEMP && fs.existsSync(audioPath)) {
      log('MAIN', 'Using existing temp/audio.mp3');
      log('MAIN', 'Step 2 done: audio ready');
    } else {
      validateApiKeysForStep('audio');
      log('MAIN', 'Generating voiceover (ElevenLabs)');
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
      // Web ReadableStream (no .pipe): consume with getReader and write chunks
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
    if (RUN_STEP === 2) {
      log('MAIN', 'Step 2 complete. Run RUN_STEP=3 next, or run without RUN_STEP for full pipeline.');
      return;
    }
  }

  // ─── STEP 3: VIDEO CLIPS ───
  const scenes = TEST_MODE ? scriptData.scenes.slice(0, 1) : scriptData.scenes;
  const tempDirForClips = TEMP_DIR;
  const allClipsExist = scenes.every((_, i) => fs.existsSync(path.join(tempDirForClips, `clip_${i}.mp4`)));
  if (RUN_STEP === null || RUN_STEP === 3) {
    stepBanner(3, 'VIDEO CLIPS');
  if (MANUAL_GROK) {
    const promptsPath = path.join(tempDirForClips, 'clip_prompts.json');
    const promptsTxtPath = path.join(tempDirForClips, 'clip_prompts.txt');
    const promptsList = scenes.map((s, i) => ({ index: i, prompt: s.prompt, filename: `clip_${i}.mp4` }));
    fs.writeFileSync(promptsPath, JSON.stringify(promptsList, null, 2));
    const txtLines = promptsList.map((p) => `--- Clip ${p.index} → ${p.filename} ---\n${p.prompt}`).join('\n\n');
    fs.writeFileSync(promptsTxtPath, txtLines);
    log('MAIN', `Step 3: manual video — exported ${scenes.length} prompts to temp/clip_prompts.json and temp/clip_prompts.txt`);
    if (!allClipsExist) {
      log('MAIN', '');
      log('VIDEO', 'Use each prompt to generate a clip, then download and save into temp/ with these exact names:');
      scenes.forEach((_, i) => log('VIDEO', `  clip_${i}.mp4`));
      log('MAIN', '');
      await waitForEnter('Press Enter when all clips are in temp/ to continue to assembly... ');
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
  const outputPath = path.resolve(process.cwd(), 'output', 'final_short.mp4');
  const audioFilePath = path.join(tempDir, 'audio.mp3');
  if (RUN_STEP === null || RUN_STEP === 4) {
    if (!fs.existsSync(audioFilePath)) {
      log('MAIN', 'temp/audio.mp3 not found. Run step 2 first (or RUN_STEP=2).');
      process.exit(1);
    }
    const missingClips = scenes.map((_, i) => `clip_${i}.mp4`).filter((name) => !fs.existsSync(path.join(tempDir, name)));
    if (missingClips.length > 0) {
      log('MAIN', `Missing clips: ${missingClips.join(', ')}. Add them to temp/ or run step 3 first.`);
      process.exit(1);
    }
  }
  const musicPath = path.resolve(process.cwd(), BACKGROUND_MUSIC_PATH);
  const useBackgroundMusic = fs.existsSync(musicPath);
  // Force 9:16 vertical for Shorts (1080x1920); scale to fit then pad so no stretch
  const videoFilter9x16 = 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2';

  await new Promise<void>((resolve, reject) => {
    const chain = ffmpeg();

    if (scenes.length === 1) {
      const clipPath = path.join(tempDir, 'clip_0.mp4');
      log('FFMPEG', `Single clip: muxing + audio${useBackgroundMusic ? ' + background music (fade in/out)' : ''} → ${outputPath} (9:16)`);
      chain.input(clipPath);
    } else {
      const listPath = path.join(tempDir, 'files.txt');
      const fileList = scenes
        .map((_, i) => path.join(tempDir, `clip_${i}.mp4`))
        .map((p) => `file '${p.replace(/\\/g, '/')}'`)
        .join('\n');
      fs.writeFileSync(listPath, fileList);
      log('FFMPEG', `Wrote concat list (${scenes.length} file(s))`);
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
}

main().catch((err) => {
  log('MAIN', `Fatal error: ${err.message}`);
  process.exit(1);
});