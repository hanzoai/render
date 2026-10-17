import { mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CHROME } from './browser.ts'
import { Fail, pick, str } from './check.ts'
import { fence, FONTS } from './fence.ts'
import type { Job, Product } from './job.ts'
import { env, run } from './proc.ts'
import { ASSET, swap } from './text.ts'

const FRAMES = fileURLToPath(import.meta.resolve('@hanzo/frames/bin/frames.mjs'))
// The Chrome frames launches: CHROME_PATH with the job's fence as its proxy.
const WRAPPER = fileURLToPath(new URL('../bin/chrome', import.meta.url))

// render.composition — an HTML composition rendered to video by @hanzo/frames,
// in a project dir of its own with every asset:// input downloaded beside it.
// frames compiles in Node and captures in its own Chrome; both reach the
// network only through the job's fence, which admits Google Fonts and
// cdn.jsdelivr.net (where compositions load GSAP from) and nothing else.
export async function composition(w: Record<string, any>, job: Job): Promise<Product> {
  const src = str(w.html, 'html', 8 << 20)
  const format = pick(w.format, 'format', ['mp4', 'webm'] as const, 'mp4')
  if (!/data-composition-id\s*=/.test(src)) throw new Fail('html has no element with data-composition-id')
  const project = join(job.dir, 'project')
  const assets = join(project, 'assets')
  const home = join(job.dir, 'home')
  await mkdir(assets, { recursive: true })
  await mkdir(home)
  const local = new Map<string, string>()
  for (const [, id] of src.matchAll(ASSET)) {
    if (!local.has(id)) local.set(id, `assets/${basename(await job.fetch(id, assets))}`)
  }
  await writeFile(join(project, 'index.html'), swap(src, (id) => local.get(id)!))
  const out = join(job.dir, `out.${format}`)
  const f = await fence([...FONTS, 'cdn.jsdelivr.net:443'], [])
  job.report(0.1, 'compiling')
  try {
    await run(process.execPath, [FRAMES, 'render', '--quality', 'high', '--no-browser-gpu', '--workers', '1', '--strict', '--format', format, '--output', out], {
      cwd: project,
      signal: job.signal,
      env: env(home, {
        FRAMES_BROWSER_PATH: WRAPPER,
        CHROME_PATH: CHROME,
        RENDER_PROXY: f.url,
        NODE_USE_ENV_PROXY: '1',
        HTTP_PROXY: f.url,
        HTTPS_PROXY: f.url,
        NO_PROXY: 'localhost,127.0.0.1,::1',
        FRAMES_NO_TELEMETRY: '1',
        DO_NOT_TRACK: '1',
        FRAMES_NO_UPDATE_CHECK: '1',
        FRAMES_NO_AUTO_INSTALL: '1',
      }),
      line: (l) => {
        const m = /(\d{1,3})%\s+(\S.*)$/.exec(l)
        if (m) job.report(0.1 + (0.8 * Math.min(100, Number(m[1]))) / 100, m[2].trim().slice(0, 80))
      },
    })
  } finally {
    await f.close()
  }
  await stat(out).catch(() => { throw new Fail('frames rendered no output') })
  return { file: out, mime: `video/${format}` }
}
