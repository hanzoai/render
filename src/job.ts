import { mkdir } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { Fail, int, num, obj, opt, str } from './check.ts'
import { composition } from './composition.ts'
import { document } from './document.ts'
import { html } from './html.ts'
import { measure } from './measure.ts'
import type { Result } from './measure.ts'
import { slides } from './slides.ts'
import { download, upload } from './transfer.ts'
import { video } from './video.ts'

export type Input = { url: string; mime: string; name: string; bytes?: number }
export type Product = { file: string; mime: string }
export type Op = (w: Record<string, any>, job: Job) => Promise<Product>
// Where the measured output goes: the engine answers with a signed PUT once it
// knows the size (the Library hands out an upload URL for a known object only).
export type Target = { url: string; headers: Record<string, string> }
// What the worker tells the engine about its one output before it uploads it: the
// file's identity and what it measured in it, which the Library item carries.
export type Meta = Result & { name: string }
export type Ask = (meta: Meta) => Promise<unknown>

export const OPS: Record<string, Op> = {
  'render.html': html,
  'render.document': document,
  'render.slides': slides,
  'render.composition': composition,
  'video.edit': video,
}

const EXT: Record<string, string> = {
  'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/svg+xml': '.svg',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv',
  'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/mp4': '.m4a', 'audio/aac': '.aac',
  'audio/ogg': '.ogg', 'audio/webm': '.webm', 'audio/flac': '.flac',
  'font/woff2': '.woff2', 'font/woff': '.woff', 'font/ttf': '.ttf', 'font/otf': '.otf',
}

// One render job: its input as Studio sent it, the temp dir it may write, and
// the signal that ends it (cancel, wall-clock limit, or shutdown).
export class Job {
  readonly op: Op
  readonly with: Record<string, any>
  readonly seconds: number
  readonly bytes: number
  readonly dir: string
  readonly signal: AbortSignal
  progress = 0
  message = 'starting'
  private readonly inputs: Record<string, unknown>
  private readonly got = new Map<string, Promise<string>>()
  private used = 0

  constructor(input: unknown, dir: string, signal: AbortSignal) {
    const i = obj(input, 'input')
    const op = OPS[i.op]
    if (!op || !Object.hasOwn(OPS, i.op)) throw new Fail(`unknown op ${String(i.op).slice(0, 64)}`)
    this.op = op
    this.with = i.with === undefined ? {} : obj(i.with, 'with')
    this.inputs = i.inputs === undefined ? {} : obj(i.inputs, 'inputs')
    const l = i.limits === undefined ? {} : obj(i.limits, 'limits')
    this.seconds = num(l.seconds, 'limits.seconds', 1, 86_400, 900)
    this.bytes = int(l.bytes, 'limits.bytes', 1, 64 * 2 ** 30, 2 ** 30)
    this.dir = dir
    this.signal = signal
  }

  report(progress: number, message: string): void {
    this.progress = Math.max(0, Math.min(1, progress))
    this.message = message
  }

  // The input an asset id names. Only these URLs are ever fetched or let through.
  input(id: string): Input {
    if (!Object.hasOwn(this.inputs, id)) throw new Fail(`unknown asset ${id.slice(0, 64)}`)
    const v = obj(this.inputs[id], `inputs.${id}`)
    const bytes = v.bytes === undefined || v.bytes === null ? undefined : int(v.bytes, `inputs.${id}.bytes`, 0, this.bytes)
    return { url: web(v.url, `inputs.${id}.url`), mime: str(v.mime, `inputs.${id}.mime`, 200), name: opt(v.name, `inputs.${id}.name`, 500), bytes }
  }

  urls(): string[] {
    return Object.keys(this.inputs).map((id) => this.input(id).url)
  }

  // Downloads an input once, into `into`, under a name of the worker's choosing.
  // Every download counts against limits.bytes.
  fetch(id: string, into = join(this.dir, 'in')): Promise<string> {
    const key = `${into}\0${id}`
    let p = this.got.get(key)
    if (!p) {
      const i = this.input(id)
      const file = join(into, `${this.got.size}${ext(i)}`)
      p = (async () => {
        await mkdir(into, { recursive: true })
        const cap = Math.min(i.bytes ?? Infinity, this.bytes - this.used)
        this.used += await download(i.url, file, cap, this.signal)
        return file
      })()
      this.got.set(key, p)
    }
    return p
  }

  // Renders, measures, asks where the output goes, and uploads it. The result
  // is what the engine records; Studio checks the object exists, so the upload
  // comes before the result is reported.
  async run(ask: Ask): Promise<Result> {
    const out = await this.op(this.with, this)
    this.report(0.95, 'uploading')
    const r = await measure(out.file, out.mime, this.signal)
    if (r.bytes > this.bytes) throw new Fail(`output is ${r.bytes} bytes, over the ${this.bytes} byte limit`)
    const title = opt(this.with.title, 'title', 500).replace(/[\\/\x00-\x1f]+/g, ' ').trim().slice(0, 100)
    const t = target(await ask({ ...r, name: `${title || 'render'}${extname(out.file)}` }))
    await upload(t.url, out.file, r.bytes, t.headers, this.signal)
    return r
  }
}

// The engine's answer to `output`: a signed PUT and the headers to send with it.
export function target(v: unknown): Target {
  const o = obj(v, 'output answer')
  const headers: Record<string, string> = {}
  for (const [k, h] of Object.entries(o.headers === undefined ? {} : obj(o.headers, 'output headers'))) {
    if (typeof h !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(k) || /[\r\n]/.test(h)) throw new Fail('output headers must map header names to strings')
    if (!/^(host|content-length|transfer-encoding|connection)$/i.test(k)) headers[k] = h
  }
  return { url: web(o.url, 'output url'), headers }
}

function web(v: unknown, name: string): string {
  const s = str(v, name, 16_384)
  let u: URL
  try { u = new URL(s) } catch { throw new Fail(`${name} is not a URL`) }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Fail(`${name} must be http or https`)
  return s
}

function ext(i: Input): string {
  const m = EXT[i.mime.split(';')[0].trim().toLowerCase()]
  if (m) return m
  const n = /\.([a-z0-9]{1,5})$/i.exec(i.name)
  return n ? `.${n[1].toLowerCase()}` : '.bin'
}
