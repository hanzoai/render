# render

Hanzo Studio's CPU render worker. A long-running Node 24 process that claims
render jobs from Studio's render lane on api.hanzo.ai, renders one output,
uploads it to a signed PUT, and reports the result. No GPU, no network listener
(except an optional `/healthz`), no build step: `node src/main.ts` runs the
TypeScript as written (type stripping, so no enums, namespaces or parameter
properties).

Published as `github.com/hanzoai/render`, built into `ghcr.io/hanzoai/render`
(linux/amd64 + linux/arm64) by hanzoai/ci.

## Layout

| file | what it does |
|---|---|
| `src/main.ts` | reads the environment, starts the worker, SIGTERM/SIGINT stop it and exit 0 |
| `src/worker.ts` | `start(config)`: N slots, each claim → `work()`; heartbeats, the wall-clock limit, cancel, shutdown; `/healthz` |
| `src/engine.ts` | `config(env)`, the bearer (static or ServiceAccount exchange), the lane's calls |
| `src/job.ts` | `Job`: input validation, input downloads under the byte cap, `run()` = op → measure → `output` → PUT |
| `src/html.ts` `document.ts` `slides.ts` `composition.ts` `video.ts` | the five ops |
| `src/browser.ts` | the shared Chrome, one fresh context per job, request interception |
| `src/fence.ts` | the per-job egress proxy every Chrome (and frames' Node) goes through |
| `src/measure.ts` | the result: sha256, image header dims, PDF pages, PPTX slides, ffprobe; the ffmpeg input whitelist |
| `src/image.ts` | an image input as Office embeds it (WebP converted to PNG) |
| `src/transfer.ts` | capped download of a signed GET, streamed PUT of the output |
| `src/proc.ts` | child processes: own process group, killed whole, clean environment |
| `src/text.ts` | HTML escaping, `**bold**`/`*italic*` runs, design tokens, `asset://` references |
| `bin/chrome` | the Chrome frames launches: `CHROME_PATH` with `--proxy-server=$RENDER_PROXY` |

## The engine protocol

Base: `${HANZO_API}${RENDER_BASE}` = `https://api.hanzo.ai/v1/studio/render`.
Studio's own engine behind a gated door; NOT `/v1/workflow` (that shard is
customer-readable). Every call is a POST with `Authorization: Bearer …` and a
JSON body.

| call | body | answer |
|---|---|---|
| `{base}/namespaces` (boot, best effort) | `{"namespaceInfo":{"name":ns}}` | ignored |
| `{base}/namespaces/{ns}/activities/claim` | `{"taskQueue","identity","leaseSeconds":120}` | `204` none, or `200` activity |
| `…/activities/{wf}/{run}/heartbeat` | `{"details":{"progress","message"}}` | `404`/`409`: cancelled or not ours → abort, report nothing |
| `…/activities/{wf}/{run}/output` | `{"mime","bytes","sha256","name"}` | `{"url":"<signed PUT>","headers":{…}}`; non-2xx fails the job |
| `…/activities/{wf}/{run}/complete` | `{"result":{…},"identity"}` | |
| `…/activities/{wf}/{run}/fail` | `{"cause":"<one line>","identity"}` | |

Order per job: claim → heartbeat (at once, then every 20s) → render → measure →
`output` → PUT (exact `bytes`, exactly the answered headers) → `complete`. The
upload precedes `complete` because Studio checks the object exists.
`type.name` other than `render` is failed with `no handler for job type <name>`.
Bad input is failed with the validation message (one line, URLs redacted).

Result: `{mime, bytes, sha256, width?, height?, seconds?, pages?}`, read back from
the file: image header dims, ffprobe for video, PDF page objects, PPTX slide parts
(`pages`). `name` sent to `output` is `with.title` (or `render`) plus the extension.

Transient errors (network, 5xx, 429, IAM down) never crash the loop: claim backs
off 1s→30s with jitter; `output`/`complete`/`fail` retry ~30s, after which the
lease expires and the engine re-dispatches. SIGTERM: stop claiming, abort jobs in
flight (children killed, contexts closed), report nothing, exit 0.

Auth: `HANZO_TOKEN` if set (local dev). Otherwise the projected ServiceAccount
token at `HANZO_SA_TOKEN` is re-read and exchanged at
`${HANZO_IAM_URL}/v1/iam/oauth/token` (`grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`,
form-encoded) for `access_token`; renewed a minute before `expires_in` (every
10 minutes when absent) and once on any 401. Tokens are never logged.

Logs: one JSON object per line on stdout — `started`, `claimed`, `done`,
`failed`, `cancelled` (engine said 404/409), `abandoned` (shutdown), `lost`
(complete answered non-2xx), `error` (transient, with `stage`). Job id
(`wf/run`), `op`, `ms`. Never a URL or a token.

## Job input

```
{ "op": "render.html" | "render.document" | "render.slides" | "render.composition" | "video.edit",
  "with": { …op params… },
  "inputs": { "lib_…": {"url":"<signed GET>","mime":"image/png","name":"a.png","bytes":123} },
  "limits": {"seconds": 900, "bytes": 1073741824} }
```

Any key of `inputs` is an asset id (Library ids, `lib_…`). In `with` an asset is
named by id; in HTML as `asset://<id>` (`[A-Za-z0-9_-]+`), replaced by the
input's signed URL (frames: a downloaded file beside the composition). Inputs are
fetched only from those URLs, no redirects, under `limits.bytes` in total and each
input's `bytes`. `limits.seconds` is a wall-clock kill. The output's mime follows
from op + format; there is no `output` in the input.

## Ops

- `render.html` `{html, width, height, format: png|jpeg|webp|pdf, scale: 1..4}` —
  exactly width×height CSS px at `scale` device px (≤ 16384 px a side). PDF: one
  page (`pageRanges: 1`), `printBackground`, screen media. Chrome quantizes PDF
  page sizes to its own units: a page lands within 1pt of width×height px.
  Waits for `networkidle0` (bounded 10s) and `document.fonts.ready` (5s).
- `render.document` `{ir:{blocks}, title, format: pdf|docx|md, tokens?}` — blocks
  heading(1..3) / paragraph / list(ordered) / quote / image(asset, caption) /
  table(rows, header) / code / break. PDF: A4 print stylesheet, page numbers in
  the footer. DOCX via `docx` (real headings, numbered and bulleted lists, header
  row, page breaks, footer numbers, embedded images). MD: the IR's own text,
  images as `asset://<id>`.
- `render.slides` `{ir:{slides}, title, format: pptx|pdf, tokens?}` — layouts
  title / content / image / split / quote; PPTX via `pptxgenjs` (16:9, editable
  text boxes, speaker notes); PDF one 1920×1080 page per slide. Both outputs share
  one geometry (`boxes()` in inches).
- `render.composition` `{html, format: mp4|webm}` — written as `index.html` in a
  fresh project dir with its assets beside it, rendered by
  `@hanzo/frames@0.7.83 render --quality high --no-browser-gpu --workers 1 --strict`
  (cwd = the project). A composition with no `window.__timelines` should carry
  `data-no-timeline` on its root, or frames polls 45s for one.
- `video.edit` `{timeline:{width?, height?, fps=30, format=mp4|webm, clips, captions?, overlays?, audio?}}` —
  clips (video, or image held `seconds`=3) trimmed by start/end, scaled+padded to
  W×H (default the first clip's, rounded to even), `setsar=1`, yuv420p, their
  audio kept (silence for clips without) and concatenated; captions burned by
  libass from a subtitle file the worker writes (`ass=filename=…`: no caption
  text in the filter string; braces and backslashes escaped so text is literal;
  DejaVu Sans Bold, fontconfig fallback for other scripts, automatic wrapping);
  overlays with enable windows; timeline audio `adelay`+`volume`, `amix
  normalize=0 duration=first`. mp4: libx264 veryfast crf 20 +faststart, AAC 192k;
  webm: VP9 crf 32 + Opus. Progress from `-progress pipe:1`.
  Captions are libass rather than drawtext because drawtext is wrong on real
  text: Ubuntu's ffmpeg 6.1.1 drops the last (bytes − characters) glyphs of any
  line holding multibyte UTF-8 ("one — kept" draws "one — ke", with `text=` or
  `textfile=`), and it neither wraps nor falls back to another font.

Design tokens (`tokens`) are CSS custom properties with the design system's own
names (`--background`, `--foreground`, `--muted-foreground`, `--primary`,
`--border`, `--font-sans`, `--font-display`, `--font-mono`). PDFs apply them all
to `:root`; DOCX/PPTX read the hex colours and first font families. A value may
not contain `; { } < > \` or a comment.

## Security model

The worker runs LLM- and user-authored HTML, so every page is treated as hostile.

- **Request interception** on every page the worker opens: only `data:`, `blob:`,
  `about:`, `https://fonts.googleapis.com/`, `https://fonts.gstatic.com/` and the
  job's exact input URLs; everything else is aborted, and the main frame may not
  navigate. Popups are closed, dialogs dismissed, downloads denied, one fresh
  browser context per job (closed after).
- **The fence** (`src/fence.ts`): a per-job forward proxy on loopback. Each job's
  context uses it with `<-loopback>` (loopback goes through it too), so what
  interception cannot see — WebSockets, workers, WebRTC over TCP — still reaches
  only the fonts and the input hosts. `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`
  keeps WebRTC off UDP. Verified: a page's WebSocket, worker fetch and TURN/TCP
  all arrive at the proxy as CONNECTs and are refused; nothing reaches the target.
- **frames** launches its own Chrome and compiles in Node (it fetches every
  `<script src>` to inline it). Its Chrome is `bin/chrome` (proxy = the job's
  fence); its Node runs with `NODE_USE_ENV_PROXY=1` and `HTTP(S)_PROXY` = the
  fence. That fence admits Google Fonts and `cdn.jsdelivr.net` (compositions load
  GSAP from there; it is public code and adds no reach into the cluster). Loopback
  is direct for frames (its own file server lives there); in the pod loopback
  holds only this process. Measured: private-address scripts, images and fetches,
  github.com and registry.npmjs.org (frames' own checks) are refused; GSAP inlines.
- **ffmpeg/ffprobe** get only files this job downloaded (and the caption file it
  wrote):
  `-protocol_whitelist file,pipe` and `-format_whitelist` (containers and still
  images, never a playlist or concat list) before every input.
- **Children** run in their own process group with a fresh environment
  (PATH, LANG, HOME and TMPDIR = the job dir); the worker's credentials never
  reach them. A cancel, timeout or shutdown kills the whole group.
- **Files**: one temp dir per job under `TMPDIR`, removed after. Nothing else is
  written, so a read-only root filesystem works with an emptyDir at `/tmp`.
- Chrome runs `--no-sandbox` (a non-root container has no user namespaces under
  RuntimeDefault seccomp); the pod is the sandbox. Deploy non-root, read-only
  root, no ServiceAccount token beyond the projected IAM one, and an egress
  NetworkPolicy that admits DNS plus 443 to public addresses only.
- Causes reported to the engine have URLs redacted (`<url>`).

## Environment

| var | default | |
|---|---|---|
| `HANZO_API` | `https://api.hanzo.ai` | |
| `RENDER_BASE` | `/v1/studio/render` | the lane's path on the API |
| `RENDER_NAMESPACE` | `render-jobs` | |
| `RENDER_QUEUE` | `render-jobs` | |
| `RENDER_IDENTITY` | hostname | |
| `RENDER_CONCURRENCY` | `2` | jobs at once (1..32) |
| `HANZO_TOKEN` | — | static bearer, local dev only |
| `HANZO_SA_TOKEN` | `/var/run/secrets/hanzo/iam/token` | projected ServiceAccount token |
| `HANZO_IAM_URL` | `https://hanzo.id` | |
| `CHROME_PATH` | `/usr/bin/chromium-headless-shell` | puppeteer's and frames' Chrome |
| `PORT` | unset | `GET /healthz` listener when set |
| `TMPDIR` | `/tmp` | all writes |

## Image

`node:24-bookworm-slim` + Debian `chromium-headless-shell` (bookworm-security
tracks upstream stable; one package for amd64 and arm64, where Chrome for Testing
has no linux-arm64 build) + `ffmpeg` (5.1, with libass and amix `normalize`) +
fonts (Noto core/mono/color emoji, DejaVu, Liberation, Inter). `npm ci --omit=dev
--ignore-scripts`; onnxruntime-node's other-platform binaries are deleted (~170 MB).
Runs as `node`. Never built on a laptop: cluster CI builds it.

## CI

`hanzo.yml`: the `unit` gate runs the suites on the runner with the runner
image's Playwright headless shell as `CHROME_PATH`, TAP output for the tally. The
runner image has no ffmpeg and no sudo, so `video.edit` and `render.composition`
skip there (adding `ffmpeg` to hanzoai/ci `runner/Dockerfile` turns them on).
`images:` one entry, both platforms, delegate lane. Callers: `.github/workflows/cicd.yml`
(github.com, the copy that builds) and `.hanzo/workflows/cicd.yml` (the forge),
both `hanzoai/ci/.github/workflows/build.yml@v2` with `secrets: inherit`.

## Testing

```
npm ci --ignore-scripts
CHROME_PATH=<a chrome-headless-shell> npm test
```

Real Chrome and ffmpeg, no mocks. `test/fake.ts` is one loopback server playing
the lane, the signed GETs and the signed PUT, recording every request.
Suites: html (exact PNG size, scale, JPEG/WebP, one-page PDF, and a hostile page
that reaches nothing), document (PDF ≥2 pages with a break, DOCX parts, MD),
slides (5 slide parts + notes, 5 PDF pages of 1920×1080), video (4s 1280×720 mp4
with audio from two mismatched clips, captions, overlay, music; image clip +
webm), composition (frames, 1s 320×240), worker (claim → heartbeat → output →
PUT → complete; heartbeat 409 drops the job; bad input fails; stop abandons).

ffmpeg needs the `ass` filter (libass), libx264, libvpx-vp9, libopus and amix
`normalize` (ffmpeg ≥ 5.0). frames times `ffmpeg -version` out at 5s, which a box
under heavy load can miss (seen on dgx at load average ~90).
