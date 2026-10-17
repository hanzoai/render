// A fake of everything the worker talks to over HTTP, on one loopback port:
// Studio's render lane under /v1/studio/render, the signed GETs of inputs
// (/files/<name>), and the signed PUT of the output (/upload/<key>). Every
// request is recorded, so a test can assert what was — and was not — reached.
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, crc32 } from 'node:zlib'
import { Job } from '../src/job.ts'
import type { Result } from '../src/measure.ts'

export type Hit = { method: string; path: string; body: Buffer; headers: http.IncomingHttpHeaders }

export type Fake = {
  url: string
  hits: Hit[]
  files: Map<string, { body: Buffer; type: string; delay?: number }>
  uploads: Map<string, Buffer>
  queue: unknown[]               // activities claim hands out, in order
  beat: number                   // status heartbeats answer
  deny: number                   // how many lane calls to answer 401 before serving again
  close(): Promise<void>
  input(name: string): { url: string; mime: string; name: string; bytes: number }
  calls(verb: string): Hit[]
}

const BASE = '/v1/studio/render/namespaces'

export async function fake(): Promise<Fake> {
  const f = { hits: [] as Hit[], files: new Map(), uploads: new Map(), queue: [] as unknown[], beat: 200, deny: 0 } as Fake
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = Buffer.concat(chunks)
    const path = (req.url ?? '').split('?')[0]
    f.hits.push({ method: req.method ?? '', path, body, headers: req.headers })
    const json = (status: number, v?: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' }).end(v === undefined ? '' : JSON.stringify(v))
    }
    if (req.method === 'GET' && path.startsWith('/files/')) {
      const file = f.files.get(path.slice(7))
      if (!file) return json(404)
      if (file.delay) await new Promise((r) => setTimeout(r, file.delay))
      res.writeHead(200, { 'content-type': file.type, 'content-length': file.body.length }).end(file.body)
      return
    }
    if (req.method === 'PUT' && path.startsWith('/upload/')) {
      f.uploads.set(path.slice(8), body)
      return json(200)
    }
    if (req.method === 'POST' && path === '/v1/iam/oauth/token') {
      const form = new URLSearchParams(body.toString())
      const ok = form.get('grant_type') === 'urn:ietf:params:oauth:grant-type:jwt-bearer' && form.get('assertion') === 'sa-jwt'
      return ok ? json(200, { access_token: `iam-${f.calls('token').length - 1}`, expires_in: 3600 }) : json(400, {})
    }
    if (path.startsWith(BASE) && f.deny > 0) {
      f.deny--
      return json(401, {})
    }
    if (req.method === 'POST' && path === BASE) return json(200, {})
    if (req.method === 'POST' && path === `${BASE}/render-jobs/activities/claim`) {
      const a = f.queue.shift()
      return a ? json(200, a) : json(204)
    }
    const m = new RegExp(`^${BASE}/render-jobs/activities/([^/]+)/([^/]+)/(heartbeat|output|complete|fail)$`).exec(path)
    if (req.method === 'POST' && m) {
      if (m[3] === 'heartbeat') return json(f.beat, {})
      if (m[3] === 'output') {
        const meta = JSON.parse(body.toString())
        return json(200, { url: `${f.url}/upload/${m[1]}`, headers: { 'Content-Type': meta.mime } })
      }
      return json(200, {})
    }
    json(404)
  })
  server.on('upgrade', (req, sock) => {
    f.hits.push({ method: 'UPGRADE', path: req.url ?? '', body: Buffer.alloc(0), headers: req.headers })
    sock.destroy()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  f.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  f.close = () => new Promise((r) => { server.closeAllConnections(); server.close(() => r()) })
  f.input = (name) => {
    const file = f.files.get(name)!
    return { url: `${f.url}/files/${name}?X-Amz-Signature=test`, mime: file.type, name, bytes: file.body.length }
  }
  f.calls = (verb) => f.hits.filter((h) => h.path.endsWith(`/${verb}`))
  return f
}

// Runs one job the way the worker does — render, measure, ask, upload — and
// returns the result with the bytes the fake received.
export async function perform(f: Fake, input: Record<string, unknown>): Promise<{ result: Result; body: Buffer }> {
  const dir = await mkdtemp(join(tmpdir(), 'job-'))
  const key = `k${f.uploads.size}`
  const job = new Job(input, dir, AbortSignal.timeout(600_000))
  const result = await job.run(async (meta) => ({ url: `${f.url}/upload/${key}`, headers: { 'Content-Type': meta.mime } }))
  return { result, body: f.uploads.get(key)! }
}

// A solid-colour PNG, written by hand so the document tests need no ffmpeg.
export function png(width: number, height: number, rgb = [40, 90, 200]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const t = Buffer.from(type, 'latin1')
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])))
    return Buffer.concat([len, t, data, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => rgb).flat())])
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array(height).fill(row)))), chunk('IEND', Buffer.alloc(0)),
  ])
}

// ffmpeg with the filters video.edit needs, or the reason a test must skip.
export const NOFFMPEG = (() => {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return 'ffmpeg is not on PATH'
  return /\sass\s/.test(r.stdout) ? false : 'the ffmpeg on PATH has no ass (libass) filter'
})()

// A test media file made by ffmpeg's lavfi sources.
export async function media(name: string, args: string[]): Promise<Buffer> {
  const out = join(await mkdtemp(join(tmpdir(), 'media-')), name)
  const r = spawnSync('ffmpeg', ['-hide_banner', '-v', 'error', '-y', ...args, out])
  if (r.status !== 0) throw new Error(`ffmpeg fixture ${name}: ${r.stderr}`)
  return readFile(out)
}

// The MediaBox of each page, in points.
export function boxes(pdf: Buffer): number[][] {
  return [...pdf.toString('latin1').matchAll(/\/MediaBox\s*\[\s*([^\]]+)\]/g)].map((m) => m[1].trim().split(/\s+/).map(Number))
}
