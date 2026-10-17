import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Fail } from './check.ts'
import type { Job } from './job.ts'
import { dims, LOCAL } from './measure.ts'
import { env, run } from './proc.ts'

export type Picture = { file: string; type: 'png' | 'jpg' | 'gif'; width: number; height: number }

// An image input as an Office document embeds it: PNG, JPEG or GIF bytes at a
// known size. WebP, which Office does not read, is converted to PNG first.
export async function picture(job: Job, id: string): Promise<Picture> {
  const mime = job.input(id).mime.split(';')[0].trim().toLowerCase()
  let file = await job.fetch(id)
  let type: Picture['type']
  if (mime === 'image/png') type = 'png'
  else if (mime === 'image/jpeg') type = 'jpg'
  else if (mime === 'image/gif') type = 'gif'
  else if (mime === 'image/webp') {
    const png = `${file}.png`
    await run('ffmpeg', ['-v', 'error', '-nostdin', '-y', ...LOCAL, '-i', file, '-frames:v', '1', png], { env: env(dirname(file)), signal: job.signal })
    file = png
    type = 'png'
  } else throw new Fail(`asset ${id} is ${mime}, not an image a document can embed (png, jpeg, gif, webp)`)
  const d = dims(await readFile(file))
  if (!d || !d.width || !d.height) throw new Fail(`asset ${id} is not a readable ${mime}`)
  return { file, type, ...d }
}
