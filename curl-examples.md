# Curl examples for Shorts API (localhost:4000)

Make sure the server is running: `npm run dev:server`

---

## Start a new job

```bash
# With a topic
curl -X POST http://localhost:4000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic": "Marina Abramović Rhythm 0", "testMode": false, "reuseTemp": false}'

# Test mode (single scene)
curl -X POST http://localhost:4000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{"topic": "A cat on a couch", "testMode": true}'

# No topic (uses temp/selected_topic.txt if present)
curl -X POST http://localhost:4000/api/jobs \
  -H "Content-Type: application/json" \
  -d '{}'
```

Response (202):

```json
{"jobId":"m1abc2xyz","status":"queued","topic":"Marina Abramović Rhythm 0"}
```

---

## Get job status

Replace `JOB_ID` with the `jobId` from the start response.

```bash
curl http://localhost:4000/api/jobs/JOB_ID
```

Example:

```bash
curl http://localhost:4000/api/jobs/m1abc2xyz
```

Response (running):

```json
{
  "id": "m1abc2xyz",
  "status": "running",
  "topic": "Marina Abramović Rhythm 0",
  "startedAt": "2026-02-11T10:00:00.000Z",
  "errorMessage": null,
  "mediaUrl": null,
  "metaUrl": null
}
```

Response (done):

```json
{
  "id": "m1abc2xyz",
  "status": "done",
  "topic": "Marina Abramović Rhythm 0",
  "startedAt": "2026-02-11T10:00:00.000Z",
  "finishedAt": "2026-02-11T10:02:30.000Z",
  "errorMessage": null,
  "mediaUrl": "/media/final_short.mp4",
  "metaUrl": "/media/youtube_meta.json"
}
```

---

## List recent jobs

```bash
curl http://localhost:4000/api/jobs
```

---

## Download the result video

```bash
curl -o final_short.mp4 http://localhost:4000/media/final_short.mp4
```

---

## Get YouTube metadata JSON

```bash
curl http://localhost:4000/media/youtube_meta.json
```

---

## Continue assembly (after adding clips)

When a job has status `waiting_for_clips`, add the required files to `temp/` on the server (e.g. `clip_0.mp4`, `clip_1.mp4`, …), then run assembly only:

```bash
curl -X POST http://localhost:4000/api/jobs/JOB_ID/continue
```

Example:

```bash
curl -X POST http://localhost:4000/api/jobs/m1abc2xyz/continue
```

On success (200), the same job is updated to `done` with `mediaUrl` and `metaUrl`. You can then `GET /api/jobs/:id` to fetch the result.
