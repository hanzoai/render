import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Fail, int, list, num, obj, pick, str } from './check.ts'
import type { Job, Product } from './job.ts'
import { LOCAL, probe } from './measure.ts'
import { env, run } from './proc.ts'

// The caption face, from the image's fonts-dejavu-core (Latin, Greek,
// Cyrillic); libass falls back through fontconfig for any other script.
export const FONT = 'DejaVu Sans'

// A path ffmpeg's filter syntax can carry without escaping.
const SAFE = /^[A-Za-z0-9/._-]+$/

type Clip = { file: string; image: boolean; start: number; seconds: number; audio: boolean; width: number; height: number }

// video.edit — clips trimmed, fitted to one size and rate, and joined; captions
// burned in (libass, from a subtitle file: no caption text is ever part of the
// filter string); overlays laid on; timeline audio mixed over the clips' own sound.
// ffmpeg reads only files this job downloaded, through demuxers that cannot
// name another file.
export async function video(w: Record<string, any>, job: Job): Promise<Product> {
  const t = obj(w.timeline, 'timeline')
  const fps = int(t.fps, 'timeline.fps', 1, 120, 30)
  const format = pick(t.format, 'timeline.format', ['mp4', 'webm'] as const, 'mp4')
  const at = (v: unknown, name: string, def?: number) => num(v, name, 0, 86_400, def)

  const clips: Clip[] = []
  for (const [i, v] of list(t.clips, 'timeline.clips', 1, 500).entries()) {
    const c = obj(v, `clip ${i}`)
    const id = str(c.asset, `clip ${i}.asset`, 200)
    const image = job.input(id).mime.startsWith('image/')
    const file = await job.fetch(id)
    const p = await probe(file, job.signal)
    if (!p.video) throw new Fail(`clip ${i} has no picture`)
    const start = at(c.start, `clip ${i}.start`, 0)
    const seconds = image
      ? num(c.seconds, `clip ${i}.seconds`, 0.04, 3600, 3)
      : Math.min(at(c.end, `clip ${i}.end`, p.seconds), p.seconds) - start
    if (!(seconds > 0)) throw new Fail(`clip ${i} has no duration between start and end`)
    clips.push({ file, image, start, seconds, audio: !image && p.audio, width: p.width, height: p.height })
  }
  const even = (n: number) => n - (n % 2)
  const W = even(int(t.width, 'timeline.width', 16, 7680, Math.min(clips[0].width, 7680)))
  const H = even(int(t.height, 'timeline.height', 16, 4320, Math.min(clips[0].height, 4320)))
  if (W < 16 || H < 16) throw new Fail('timeline size must be at least 16 × 16')
  const total = clips.reduce((s, c) => s + c.seconds, 0)

  const args = ['-hide_banner', '-nostdin', '-y', '-v', 'error', '-progress', 'pipe:1', '-nostats']
  const graph: string[] = []
  let n = 0
  const input = (file: string, pre: string[] = []) => { args.push(...LOCAL, ...pre, '-i', file); return n++ }

  const joined: string[] = []
  for (const [i, c] of clips.entries()) {
    const k = c.image
      ? input(c.file, ['-loop', '1', '-framerate', String(fps), '-t', s(c.seconds)])
      : input(c.file, ['-ss', s(c.start), '-t', s(c.seconds)])
    graph.push(`[${k}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS[v${i}]`)
    graph.push(c.audio
      ? `[${k}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,apad,atrim=0:${s(c.seconds)},asetpts=PTS-STARTPTS[a${i}]`
      : `anullsrc=r=48000:cl=stereo,atrim=0:${s(c.seconds)}[a${i}]`)
    joined.push(`[v${i}][a${i}]`)
  }
  graph.push(`${joined.join('')}concat=n=${clips.length}:v=1:a=1[v][a]`)
  let v = 'v'

  const captions = list(t.captions, 'timeline.captions', 0, 1000)
  if (captions.length) {
    const file = join(job.dir, 'captions.ass')
    if (!SAFE.test(file)) throw new Fail('temp dir path cannot be passed to ffmpeg filters')
    const size = Math.max(12, Math.round(H * 0.05))
    const margin = Math.round(H * 0.07)
    const style = (name: string, align: number) =>
      `Style: ${name},${FONT},${size},&H00FFFFFF,&H00FFFFFF,&H26000000,&H00000000,-1,0,0,0,100,100,0,0,1,${Math.max(2, Math.round(size / 12))},0,${align},${Math.round(W * 0.05)},${Math.round(W * 0.05)},${margin},1`
    const lines = captions.map((x, i) => {
      const c = obj(x, `caption ${i}`)
      const text = str(c.text, `caption ${i}.text`, 2000)
      const from = at(c.start, `caption ${i}.start`, 0)
      const to = at(c.end, `caption ${i}.end`, total)
      const where = pick(c.position, `caption ${i}.position`, ['bottom', 'top', 'center'] as const, 'bottom')
      return `Dialogue: 0,${clock(from)},${clock(to)},${where},,0,0,0,,${literal(text)}`
    })
    await writeFile(file, [
      '[Script Info]', 'ScriptType: v4.00+', `PlayResX: ${W}`, `PlayResY: ${H}`, 'WrapStyle: 0', 'ScaledBorderAndShadow: yes', '',
      '[V4+ Styles]',
      'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
      style('bottom', 2), style('top', 8), style('center', 5), '',
      '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text', ...lines, '',
    ].join('\n'))
    graph.push(`[${v}]ass=filename=${file}[vc]`)
    v = 'vc'
  }

  for (const [i, x] of list(t.overlays, 'timeline.overlays', 0, 50).entries()) {
    const o = obj(x, `overlay ${i}`)
    const id = str(o.asset, `overlay ${i}.asset`, 200)
    const image = job.input(id).mime.startsWith('image/')
    const file = await job.fetch(id)
    const from = at(o.start, `overlay ${i}.start`, 0)
    const to = at(o.end, `overlay ${i}.end`, total)
    const k = image ? input(file, ['-loop', '1', '-framerate', String(fps), '-t', s(total)]) : input(file)
    graph.push(`[${k}:v]setpts=PTS-STARTPTS${image ? '' : `+${s(from)}/TB`}[o${i}]`)
    graph.push(`[${v}][o${i}]overlay=x=${int(o.x, `overlay ${i}.x`, -W, W, 0)}:y=${int(o.y, `overlay ${i}.y`, -H, H, 0)}:eof_action=pass:enable='between(t,${s(from)},${s(to)})'[vo${i}]`)
    v = `vo${i}`
  }

  let a = 'a'
  const tracks = list(t.audio, 'timeline.audio', 0, 20)
  if (tracks.length) {
    const mixed: string[] = []
    for (const [i, x] of tracks.entries()) {
      const tr = obj(x, `audio ${i}`)
      const file = await job.fetch(str(tr.asset, `audio ${i}.asset`, 200))
      if (!(await probe(file, job.signal)).audio) throw new Fail(`audio ${i} has no sound`)
      const delay = Math.round(at(tr.start, `audio ${i}.start`, 0) * 1000)
      const k = input(file)
      graph.push(`[${k}:a]aresample=48000,aformat=sample_rates=48000:channel_layouts=stereo,volume=${num(tr.volume, `audio ${i}.volume`, 0, 4, 1)},adelay=delays=${delay}:all=1[t${i}]`)
      mixed.push(`[t${i}]`)
    }
    graph.push(`[a]${mixed.join('')}amix=inputs=${tracks.length + 1}:normalize=0:duration=first[am]`)
    a = 'am'
  }

  const out = join(job.dir, `out.${format}`)
  args.push('-filter_complex', graph.join(';'), '-map', `[${v}]`, '-map', `[${a}]`, '-t', s(total), '-r', String(fps))
  if (format === 'mp4') {
    args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2', '-movflags', '+faststart')
  } else {
    args.push('-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-deadline', 'good', '-cpu-used', '5', '-row-mt', '1', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '160k', '-ar', '48000', '-ac', '2')
  }
  args.push(out)
  job.report(0.1, 'encoding')
  await run('ffmpeg', args, {
    cwd: job.dir,
    env: env(job.dir),
    signal: job.signal,
    line: (l) => {
      const m = /^out_time_us=(\d+)$/.exec(l)
      if (m) job.report(0.1 + 0.85 * Math.min(1, Number(m[1]) / 1e6 / total), 'encoding')
    },
  })
  return { file: out, mime: `video/${format}` }
}

// Seconds as ffmpeg reads them.
function s(n: number): string {
  return String(Math.round(n * 1000) / 1000)
}

// An ASS timestamp, H:MM:SS.cc.
function clock(sec: number): string {
  const cs = Math.round(sec * 100)
  const h = Math.floor(cs / 360000), m = Math.floor(cs / 6000) % 60, x = (cs % 6000) / 100
  return `${h}:${String(m).padStart(2, '0')}:${x.toFixed(2).padStart(5, '0')}`
}

// Caption text exactly as written. libass reads {…} as override tags and \N, \n,
// \h as breaks, so braces are escaped and a zero-width space after each
// backslash keeps it from starting a sequence; a newline is a line break.
function literal(text: string): string {
  return text.replace(/\\/g, '\\\u200b').replace(/[{}]/g, (c) => `\\${c}`).replace(/\r\n?|\n/g, '\\N')
}
