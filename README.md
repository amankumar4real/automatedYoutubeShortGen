# Automate Shorts — Documentation

Pipeline to create YouTube Shorts: script (OpenAI) → voiceover (ElevenLabs) → video clips (manual or xAI Grok) → assembly (FFmpeg). Supports single-step runs and optional background music.

---

## Picking a topic (dark / true crime / mystery)

Run the interactive topic picker to get suggestions and choose one:

```bash
npx tsc && node get_topic.js
```

- **What it does:** Asks ChatGPT for 15 dark, real-life topic ideas (true crime, unsolved mystery, unhinged history, scary real events). Topics that are widely discussed or “trending” in its training are listed first.
- **Prompts:** Enter a number **1–15** to choose that topic, **next** (or **n**) to get 15 more, or **q** to quit.
- **After you choose:** The selected topic is saved to `temp/selected_topic.txt`. The next time you run `automate_shorts`, it will use this topic automatically (no need to edit code).
- **Trending note:** Order is based on ChatGPT’s training (commonly searched/discussed). For real-time trending you could add a separate service (e.g. Google Trends API) later; the script can be extended to merge that with ChatGPT suggestions.

---

## Prerequisites

- **Node.js** (v18+)
- **FFmpeg** (e.g. `brew install ffmpeg`)
- **API keys** (see below)

---

## Environment (.env)

Create a `.env` file in the project root (see `.env.example`):

```env
OPENAI_API_KEY=sk-...      # Script generation (required for step 1)
ELEVEN_API_KEY=...         # Voiceover (required for step 2)
XAI_API_KEY=...             # Only if MANUAL_GROK=false (Grok API for clips)
```

For the API with auth and projects:

```env
MONGODB_URI=mongodb://localhost:27017   # or Atlas connection string
MONGODB_DB_NAME=shorts
JWT_SECRET=change-me-in-production      # use a strong secret in production
```

For R2 asset storage (optional):

```env
R2_ACCOUNT_ID=...
R2_ACCESS_KEY_ID=...
R2_SECRET_ACCESS_KEY=...
R2_BUCKET_NAME=...
```

Other optional:

```env
BACKGROUND_MUSIC_PATH=temp/background_music.mp3
RUN_STEP=1
PORT=4000
```

---

## Config (in code)

Edit `automate_shorts.ts` if you want to change defaults:

| Variable | Default | Description |
|----------|---------|-------------|
| `TEST_MODE` | `false` | `true` = one short scene, minimal voiceover (for testing). |
| `REUSE_TEMP` | `false` | `true` = reuse existing `temp/script.json`, `temp/audio.mp3`, and clips instead of calling APIs. |
| `MANUAL_GROK` | `true` | `true` = no xAI API; you create clips elsewhere and put them in `temp/`. `false` = use Grok API for clips. |
| `BACKGROUND_MUSIC_PATH` | `temp/background_music.mp3` | Path to background music file (relative to project). If file exists, it’s mixed with fade in/out. |
| **Topic** | From `temp/selected_topic.txt` if present (after running `get_topic`), else `"The Beast of Gévaudan (1760s France)"` | Run `node get_topic.js` to pick a topic; it writes `temp/selected_topic.txt`. |

---

## The 4 Steps

### STEP 1: SCRIPT

- **What it does:** Generates a short script (voiceover + scene prompts) with OpenAI.
- **Inputs:** Topic (set in code).
- **Outputs:** `temp/script.json` (voiceover text + array of scene prompts).
- **Rules:** Voiceover max 900 characters; natural, detailed style; hook at the start; scene prompts in-depth and ending with `9:16 aspect ratio, vertical portrait format`.

### STEP 2: VOICEOVER

- **What it does:** Converts the script’s voiceover text to speech with ElevenLabs.
- **Inputs:** `temp/script.json` (voiceover field).
- **Outputs:** `temp/audio.mp3`.
- **Settings (in code):** Model `eleven_multilingual_v2`; voice settings (stability, similarity, speed 0.99, speaker boost, etc.).

### STEP 3: VIDEO CLIPS

- **What it does:**  
  - **If `MANUAL_GROK=true`:** Writes `temp/clip_prompts.json` and `temp/clip_prompts.txt` from the script’s scenes, then waits for you to add `temp/clip_0.mp4`, `temp/clip_1.mp4`, … (one per scene). Press Enter when done to continue (or exit if running only step 3).  
  - **If `MANUAL_GROK=false`:** Calls xAI Grok API to generate each clip and downloads them into `temp/`.
- **Inputs:** `temp/script.json` (scenes).
- **Outputs:** `temp/clip_prompts.json`, `temp/clip_prompts.txt`, and `temp/clip_0.mp4`, `temp/clip_1.mp4`, … (you create these when manual).

### STEP 4: ASSEMBLY

- **What it does:** Concatenates all clips, muxes with voiceover (and optional background music with 2s fade in/out), outputs one MP4.
- **Inputs:** `temp/script.json` (scene count), `temp/audio.mp3`, `temp/clip_0.mp4` … `temp/clip_N.mp4`. Optional: `temp/background_music.mp3` (or path from env).
- **Outputs:** `output/final_short.mp4`.
- **Behaviour:** Uses `-shortest` so duration = min(total video length, audio length). Only the first video stream of each clip is used (ignores thumbnail/attached-picture streams).

---

## Running the pipeline (CLI)

### Full pipeline (all 4 steps)

```bash
npx tsc
node automate_shorts.js
```

Or compile once and run JS:

```bash
npx tsc && node automate_shorts.js
```

### Single-step runs

Run only one step by setting `RUN_STEP`:

```bash
# Step 1 only — generate script → temp/script.json
RUN_STEP=1 node automate_shorts.js

# Step 2 only — generate voiceover (requires temp/script.json) → temp/audio.mp3
RUN_STEP=2 node automate_shorts.js

# Step 3 only — export prompts and, if manual, wait for clips in temp/
RUN_STEP=3 node automate_shorts.js

# Step 4 only — assemble (requires temp/script.json, temp/audio.mp3, temp/clip_*.mp4) → output/final_short.mp4
RUN_STEP=4 node automate_shorts.js
```

For step 4, script, audio, and all `clip_0.mp4` … `clip_N.mp4` must already exist in `temp/`; otherwise the script exits with a clear error.

---

## Backend API + Web client

### Backend (API server)

Start the Node backend (Express) on port 4000:

```bash
npm install
npm run dev:server
```

This exposes:

- **Auth:** `POST /api/auth/register`, `POST /api/auth/login` (username + password; JWT token).
- **Projects (per-user):** `POST /api/projects` (create; optional `Idempotency-Key`), `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id/continue`, optional `POST /api/projects/:id/clips` (multipart clip upload).
- **Legacy jobs:** `POST /api/jobs`, `GET /api/jobs/:id`, `GET /api/jobs` (all require auth).
- `GET /media/*` — serve generated MP4 and `youtube_meta.json` (and project media when R2 is not used).

### Frontend (web client)

Serve the simple web client:

```bash
npm run dev:frontend
```

Then visit the printed URL (for example `http://localhost:3000`) and set the **API base URL** field to:

```text
http://localhost:4000
```

Use the client to:

- **Log in or register** (username + password); then open **My Shorts** (project list).
- Create a new short (topic + optional test mode); open a project to see status, stage history, “Continue assembly” when waiting for clips, and the final video + YouTube metadata.
- API base URL is stored per session; set it on the login page or on the project list.

### Exposing the backend via ngrok (optional)

If you want to access your local backend from another device:

1. Run ngrok:

   ```bash
   ngrok http 4000
   ```

2. Ngrok will print a public HTTPS URL, e.g.:

   ```text
   https://your-subdomain.ngrok.io
   ```

3. In the web client, set **API base URL** to that ngrok URL instead of `http://localhost:4000`.

All client requests will then be tunneled to your local Express backend.

### Production deployment (server + HTTPS)

To host the backend on a VPS and expose it over HTTPS with a free temporary URL you can use **Docker** (recommended) or the **PM2 + cloudflared scripts**.

#### Deploy on your server (Docker, quick steps)

1. **SSH into your server** and install Docker + Docker Compose if needed:
   - [Docker Engine](https://docs.docker.com/engine/install/)  
   - [Docker Compose](https://docs.docker.com/compose/install/) (or use the plugin: `docker compose`)

2. **Clone the repo and add config:**
   ```bash
   git clone <your-repo-url> scripts && cd scripts
   cp .env.example .env
   nano .env   # set at least: JWT_SECRET, OPENAI_API_KEY, ELEVEN_API_KEY; MONGODB_URI is overridden by compose
   ```

3. **Deploy:**
   ```bash
   chmod +x deploy/docker-deploy.sh
   ./deploy/docker-deploy.sh
   ```
   Or manually: `docker compose up -d --build`

4. **Get your public URL:** The tunnel prints an HTTPS URL. Run:
   ```bash
   docker compose logs -f tunnel
   ```
   Copy the `https://...trycloudflare.com` URL when it appears (Ctrl+C to exit logs).

5. **Use the app:** In the frontend, set **API base URL** to that URL. Check: `curl -s https://YOUR-URL/health` → `{"ok":true}`.

**Useful commands:** `docker compose ps` (status), `docker compose logs -f api` (API logs), `docker compose down` (stop). To run only the API (no tunnel), use `docker compose up -d api` and expose port 4000 yourself (e.g. reverse proxy).

#### Option B: PM2 + cloudflared scripts

1. **On the server** (after cloning the repo and copying `.env`):
   - Run `./deploy/01-setup-runtime.sh` (checks Node 18+, runs `npm ci`, `npm run build`, checks `.env`).
   - Run `./deploy/02-pm2.sh` (starts backend with PM2, saves process list, enables startup on reboot). If PM2 prints a `sudo env PATH=...` command, run it.
   - Install cloudflared (Ubuntu: download `.deb` from [cloudflared releases](https://github.com/cloudflare/cloudflared/releases), then `sudo dpkg -i cloudflared.deb`). Run `./deploy/03-tunnel.sh` and leave it running (or run inside `tmux`/`screen`). Note the `https://*.trycloudflare.com` URL it prints.

2. **Frontend:** Open the web client (locally or hosted). Set **API base URL** to the tunnel URL (e.g. `https://abc123.trycloudflare.com`). Log in and use the app; all API calls go over HTTPS to your server.

3. **Verify:** `curl -s https://YOUR-TUNNEL-URL/health` should return `{"ok":true}`. Use `pm2 status` and `pm2 logs shorts-api` on the server to check the backend.

If the tunnel process stops, the URL changes; run `./deploy/03-tunnel.sh` again (or restart the `tunnel` container with Docker) to get a new one. For a stable hostname, use a Cloudflare account and a named tunnel or your own domain.

---

## Manual video workflow (MANUAL_GROK=true)

1. Run step 1 and 2 (or full pipeline until it stops at step 3):  
   You get `temp/clip_prompts.json` and `temp/clip_prompts.txt`.
2. Use each prompt in `temp/clip_prompts.txt` (or the JSON) in your video tool (e.g. Grok terminal). Generate one clip per scene.
3. Download/save each clip as `temp/clip_0.mp4`, `temp/clip_1.mp4`, … in order.
4. Either:
   - Press Enter in the same run (if the script is waiting), and it continues to step 4 (assembly), or  
   - Run again with `RUN_STEP=4` (and optionally `REUSE_TEMP=true`) to assemble only.

---

## Starting a new short (clearing previous project)

When you run the **full pipeline** (no `RUN_STEP`) and **`REUSE_TEMP=false`**, if the script finds existing project data in `temp/` (script, audio, or clips), it will:

1. Tell you it found existing data.
2. Ask you to press Enter to:
   - Rename `output/final_short.mp4` to `output/final_short_YYYY-MM-DDTHH-mm-ss.mp4` if it exists.
   - Delete `temp/script.json`, `temp/audio.mp3`, `temp/clip_prompts.*`, `temp/files.txt`, and all `temp/clip_*.mp4`.
3. Then continue with a fresh step 1.

If you only run a single step (e.g. `RUN_STEP=1`), this clear-and-save step is **not** run; you can clear `temp/` yourself if you want a new short.

---

## Background music

- **Path:** By default `temp/background_music.mp3`. Override with env: `BACKGROUND_MUSIC_PATH=path/to/music.mp3`.
- **Behaviour:** If the file exists at assembly (step 4), it is mixed with the voiceover: music at ~18% volume, 2s fade in at start, 2s fade out at end (based on voiceover length).
- **If the file is missing:** Assembly runs as usual with no music.

---

## Script style (step 1)

The OpenAI prompt is tuned for:

- **Voiceover:** Natural, documentary-style; max 900 characters; first sentence = hook; concrete details (names, numbers, events); no filler.
- **Scene prompts:** 2–4 sentences each; setting, lighting, camera angle, mood, key objects/actions; **must end with** `9:16 aspect ratio, vertical portrait format` for Shorts.

You can change the topic and tone by editing the `topic` variable and the `getScript()` prompt in `automate_shorts.ts`.

---

## File structure

```
scripts/
├── .env                    # API keys (OPENAI_API_KEY, ELEVEN_API_KEY, optional XAI_API_KEY)
├── automate_shorts.ts      # Source
├── automate_shorts.js      # Compiled (after npx tsc)
├── AUTOMATE_SHORTS.md      # This file
├── temp/
│   ├── script.json        # From step 1
│   ├── audio.mp3          # From step 2
│   ├── clip_prompts.json  # From step 3
│   ├── clip_prompts.txt   # From step 3 (copy-paste prompts)
│   ├── clip_0.mp4 …      # Your clips (step 3 manual or API)
│   ├── files.txt          # FFmpeg concat list (step 4)
│   └── background_music.mp3  # Optional
└── output/
    └── final_short.mp4    # Final video (step 4)
```

---

## Quick reference

| Goal | Command / setting |
|------|-------------------|
| Full run | `node automate_shorts.js` |
| Script only | `RUN_STEP=1 node automate_shorts.js` |
| Voiceover only | `RUN_STEP=2 node automate_shorts.js` |
| Export prompts / wait for clips | `RUN_STEP=3 node automate_shorts.js` |
| Assembly only | `RUN_STEP=4 node automate_shorts.js` |
| Reuse existing temp files | Set `REUSE_TEMP = true` in code |
| Use Grok API for clips | Set `MANUAL_GROK = false` and set `XAI_API_KEY` in `.env` |
| Add background music | Put a file at `temp/background_music.mp3` (or set `BACKGROUND_MUSIC_PATH`) |
| Change topic | Run `node get_topic.js` and pick one, or edit `temp/selected_topic.txt`, or set `DEFAULT_TOPIC` in `automate_shorts.ts` |

---

## Troubleshooting

- **Missing credentials:** Ensure `.env` has `OPENAI_API_KEY` and `ELEVEN_API_KEY` for steps 1 and 2. For Grok API (step 3), `XAI_API_KEY` is only needed when `MANUAL_GROK=false`.
- **Step 4 fails (missing file):** Run the step that produces the missing file (e.g. step 2 for `temp/audio.mp3`, step 3 for clips), or add the file to `temp/` with the expected name.
- **FFmpeg “Cannot find ffmpeg”:** Install FFmpeg (e.g. `brew install ffmpeg` on macOS).
- **Previous short overwritten:** Use the “save and clear” flow when starting a new short (run full pipeline with `REUSE_TEMP=false` and press Enter when prompted), or manually rename `output/final_short.mp4` and clear `temp/` before running.
