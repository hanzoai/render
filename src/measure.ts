import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Fail } from './check.ts'
import { env, run } from './proc.ts'

export type Result = { mime: string; bytes: number; sha256: string; width?: number; height?: number; seconds?: number; pages?: number }

export const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
export const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

// What the engine is told about the one output, read back from the file itself.
export async function measure(file: string, mime: string, signal: AbortSignal): Promise<Result> {
  const r: Result = { mime, bytes: (await stat(file)).size, sha256: await sha256(file) }
  if (mime.startsWith('image/')) {
    const d = dims(await readFile(file))
    if (!d) throw new Fail(`output is not a readable ${mime}`)
    Object.assign(r, d)
  } else if (mime.startsWith('video/')) {
    const p = await probe(file, signal)
    if (!p.width || !p.height) throw new Fail('output has no video stream')
    Object.assign(r, { width: p.width, height: p.height, seconds: Math.round(p.seconds * 1000) / 1000 })
  } else if (mime === 'application/pdf') {
    r.pages = await pdfPages(file)
  } else if (mime === PPTX) {
    r.pages = zipNames(await readFile(file)).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).length
  }
  return r
}

export function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256')
    createReadStream(file).on('data', (c) => h.update(c)).on('end', () => resolve(h.digest('hex'))).on('error', reject)
  })
}

// Pixel size from a PNG, JPEG, WebP or GIF header.
export function dims(b: Buffer): { width: number; height: number } | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR') {
    return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
  }
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') {
    return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  }
  if (b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const v = b.readUInt32LE(21)
      return { width: (v & 0x3fff) + 1, height: ((v >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) return null
      const m = b[i + 1]
      if (m === 0xff) { i++; continue }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) }
      }
      i += 2 + b.readUInt16BE(i + 2)
    }
  }
  return null
}

// Page objects in a PDF. Chrome writes them as plain objects, never inside a
// compressed object stream, so each one is a `/Type /Page` in the bytes.
export async function pdfPages(file: string): Promise<number> {
  const s = (await readFile(file)).toString('latin1')
  if (!s.startsWith('%PDF-')) throw new Fail('output is not a PDF')
  return s.match(/\/Type\s*\/Page(?![a-zA-Z])/g)?.length ?? 0
}

// Entry names from a ZIP's central directory (PPTX and DOCX are ZIPs).
export function zipNames(b: Buffer): string[] {
  let e = b.length - 22
  while (e >= 0 && b.readUInt32LE(e) !== 0x06054b50) e--
  if (e < 0) throw new Fail('output is not a zip archive')
  const count = b.readUInt16LE(e + 10)
  let p = b.readUInt32LE(e + 16)
  const names: string[] = []
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(p) !== 0x02014b50) throw new Fail('zip central directory is damaged')
    const n = b.readUInt16LE(p + 28), x = b.readUInt16LE(p + 30), c = b.readUInt16LE(p + 32)
    names.push(b.toString('utf8', p + 46, p + 46 + n))
    p += 46 + n + x + c
  }
  return names
}

export type Probe = { seconds: number; width: number; height: number; audio: boolean; video: boolean }

// Demuxers ffmpeg and ffprobe may open: containers and still images, never a
// playlist or a concat list, so a crafted input cannot name another file.
export const FORMATS = 'mov,matroska,webm,avi,mpegts,mp3,wav,flac,ogg,aac,image2,png_pipe,jpeg_pipe,webp_pipe,gif,bmp_pipe'
export const LOCAL = ['-protocol_whitelist', 'file,pipe', '-format_whitelist', FORMATS]

export async function probe(file: string, signal: AbortSignal): Promise<Probe> {
  const out = await run('ffprobe', ['-v', 'error', ...LOCAL, '-print_format', 'json', '-show_format', '-show_streams', file],
    { env: env(dirname(file)), signal })
  const j = JSON.parse(out)
  const streams: any[] = j.streams ?? []
  const v = streams.find((s) => s.codec_type === 'video')
  const a = streams.some((s) => s.codec_type === 'audio')
  const seconds = Number(j.format?.duration ?? v?.duration ?? 0)
  return { seconds: Number.isFinite(seconds) ? seconds : 0, width: v?.width ?? 0, height: v?.height ?? 0, audio: a, video: Boolean(v) }
}
